import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Plan, Prisma, SubStatus } from '@prisma/client';
import {
  ManagedLicenseResponse,
  PLAN_LIMITS,
  SubscriptionInfo,
  Plan as SharedPlan,
} from '@interview/shared';
import { PrismaService } from '../prisma/prisma.service';
import { getDevSubscriptionInfo, isDevSkipSubscription } from '../config/dev.config';
import { mintLicenseKey } from '../gateway/license.util';
import { computeSubscriptionActivation } from './subscription-renewal';

interface AccountLicenseConfig {
  privateKeyHex: string;
  now: () => Date;
}

function defaultAccountLicenseConfig(): AccountLicenseConfig {
  return {
    privateKeyHex: process.env.LICENSE_PRIVATE_KEY_HEX ?? '',
    now: () => new Date(),
  };
}

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly licenseConfig: AccountLicenseConfig = defaultAccountLicenseConfig(),
  ) {}

  isDevMode(): boolean {
    return isDevSkipSubscription();
  }

  getByUserId(userId: string) {
    return this.prisma.subscription.findUnique({ where: { userId } });
  }

  async activateForEmail(
    rawEmail: string,
    plan: Plan,
    provider: 'STRIPE' | 'YOOKASSA',
    externalId: string,
    durationDays: number,
  ): Promise<{ pending: boolean }> {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user?.emailVerifiedAt) {
      await this.activateSubscription(
        user.id,
        plan,
        provider,
        externalId,
        this.periodEndFromDays(durationDays),
      );
      return { pending: false };
    }

    await this.prisma.pendingEntitlement.upsert({
      where: { provider_externalId: { provider, externalId } },
      create: { email, plan, provider, externalId, durationDays },
      update: {},
    });
    return { pending: true };
  }

  async claimPending(userId: string, rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    if (typeof (this.prisma as unknown as { $transaction?: unknown }).$transaction === 'function') {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`skillcue-entitlement:${email}`}))::text AS lock`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`skillcue-subscription:${userId}`}))::text AS lock`;
        const pending = await tx.pendingEntitlement.findMany({
          where: { email, claimedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        for (const entitlement of pending) {
          await this.activateWithClient(
            tx,
            userId,
            entitlement.plan,
            entitlement.provider,
            entitlement.externalId,
            this.periodEndFromDays(entitlement.durationDays),
          );
          await tx.pendingEntitlement.update({
            where: { id: entitlement.id },
            data: { claimedAt: new Date(), claimedByUserId: userId },
          });
        }
      });
      return;
    }
    const pending = await this.prisma.pendingEntitlement.findMany({
      where: { email, claimedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    for (const entitlement of pending) {
      await this.activateSubscription(
        userId,
        entitlement.plan,
        entitlement.provider,
        entitlement.externalId,
        this.periodEndFromDays(entitlement.durationDays),
      );
      await this.prisma.pendingEntitlement.updateMany({
        where: { id: entitlement.id, claimedAt: null },
        data: { claimedAt: new Date(), claimedByUserId: userId },
      });
    }
  }

  async getSubscriptionInfo(userId: string): Promise<SubscriptionInfo> {
    if (isDevSkipSubscription()) {
      return getDevSubscriptionInfo();
    }
    const sub = await this.getByUserId(userId);
    if (!sub) {
      return {
        plan: null,
        status: SubStatus.EXPIRED as SubscriptionInfo['status'],
        currentPeriodEnd: null,
        sttMinutesUsed: 0,
        llmTokensUsed: 0,
        limits: null,
      };
    }

    const sharedPlan = sub.plan as unknown as SharedPlan;
    const periodExpired = sub.currentPeriodEnd != null
      && sub.currentPeriodEnd.getTime() <= this.licenseConfig.now().getTime();
    return {
      plan: sharedPlan,
      status: periodExpired && sub.status === SubStatus.ACTIVE
        ? SubStatus.EXPIRED as SubscriptionInfo['status']
        : sub.status as SubscriptionInfo['status'],
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      sttMinutesUsed: sub.sttMinutesUsed,
      llmTokensUsed: sub.llmTokensUsed,
      limits: PLAN_LIMITS[sharedPlan],
    };
  }

  async getManagedLicense(userId: string): Promise<ManagedLicenseResponse> {
    const now = this.licenseConfig.now();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { subscription: true },
    });
    const subscription = user?.subscription;
    const devPlan = isDevSkipSubscription() ? Plan.PRO : null;
    const plan = devPlan ?? subscription?.plan ?? null;
    const activeUntil = devPlan
      ? new Date(now.getTime() + 24 * 60 * 60 * 1000)
      : subscription?.currentPeriodEnd ?? null;
    const active = Boolean(
      user
      && plan
      && (devPlan || subscription?.status === SubStatus.ACTIVE)
      && activeUntil
      && activeUntil.getTime() > now.getTime(),
    );
    if (!active || !user || !plan || !activeUntil) {
      return { active: false, key: null, expiresAt: null };
    }

    const privateKeyHex = this.licenseConfig.privateKeyHex.trim();
    if (!/^[a-f0-9]{64}$/iu.test(privateKeyHex)) {
      throw new ServiceUnavailableException({
        code: 'LICENSE_SIGNING_UNAVAILABLE',
        message: 'Managed subscription signing is unavailable',
      });
    }
    const expiresAt = new Date(Math.min(
      activeUntil.getTime(),
      now.getTime() + 24 * 60 * 60 * 1000,
    ));
    const sharedPlan = plan as unknown as SharedPlan;
    const key = mintLicenseKey({
      email: user.email,
      plan: plan === Plan.BASIC ? 'basic' : 'max',
      issuedAt: Math.floor(now.getTime() / 1000),
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
      tokensMonth: PLAN_LIMITS[sharedPlan].llmTokensPerMonth,
      accountId: user.id,
      source: 'account',
    }, privateKeyHex);
    return { active: true, key, expiresAt: expiresAt.toISOString() };
  }

  async activateSubscription(
    userId: string,
    plan: Plan,
    provider: 'STRIPE' | 'YOOKASSA',
    externalId: string,
    periodEnd: Date,
  ) {
    if (typeof (this.prisma as unknown as { $transaction?: unknown }).$transaction !== 'function') {
      return this.activateWithClient(this.prisma, userId, plan, provider, externalId, periodEnd);
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`skillcue-subscription:${userId}`}))::text AS lock`;
      return this.activateWithClient(tx, userId, plan, provider, externalId, periodEnd);
    });
  }

  private async activateWithClient(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    plan: Plan,
    provider: 'STRIPE' | 'YOOKASSA',
    externalId: string,
    periodEnd: Date,
  ) {
    const current = await db.subscription.findUnique({ where: { userId } });
    const activation = computeSubscriptionActivation(
      current ? {
        plan: current.plan,
        status: current.status,
        currentPeriodEnd: current.currentPeriodEnd,
      } : null,
      plan,
      periodEnd,
      new Date(),
    );
    return db.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan: activation.plan,
        status: SubStatus.ACTIVE,
        provider,
        externalId,
        currentPeriodEnd: activation.currentPeriodEnd,
        sttMinutesUsed: 0,
        llmTokensUsed: 0,
      },
      update: {
        plan: activation.plan,
        status: SubStatus.ACTIVE,
        provider,
        externalId,
        currentPeriodEnd: activation.currentPeriodEnd,
        sttMinutesUsed: 0,
        llmTokensUsed: 0,
      },
    });
  }

  async incrementSttUsage(userId: string, minutes: number) {
    const sub = await this.getByUserId(userId);
    if (!sub) return;
    await this.prisma.subscription.update({
      where: { userId },
      data: { sttMinutesUsed: sub.sttMinutesUsed + minutes },
    });
  }

  async incrementLlmUsage(userId: string, tokens: number) {
    const sub = await this.getByUserId(userId);
    if (!sub) return;
    await this.prisma.subscription.update({
      where: { userId },
      data: { llmTokensUsed: sub.llmTokensUsed + tokens },
    });
  }

  checkSttQuota(sub: { plan: Plan; sttMinutesUsed: number }): boolean {
    const limits = PLAN_LIMITS[sub.plan as unknown as SharedPlan];
    return sub.sttMinutesUsed < limits.sttMinutesPerMonth;
  }

  checkLlmQuota(sub: { plan: Plan; llmTokensUsed: number }, tokensNeeded = 1000): boolean {
    const limits = PLAN_LIMITS[sub.plan as unknown as SharedPlan];
    return sub.llmTokensUsed + tokensNeeded <= limits.llmTokensPerMonth;
  }

  private periodEndFromDays(durationDays: number): Date {
    const end = new Date();
    end.setUTCDate(end.getUTCDate() + Math.max(0, durationDays));
    return end;
  }
}
