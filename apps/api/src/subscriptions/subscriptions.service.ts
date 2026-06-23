import { Injectable } from '@nestjs/common';
import { Plan, SubStatus } from '@prisma/client';
import { PLAN_LIMITS, SubscriptionInfo, Plan as SharedPlan } from '@interview/shared';
import { PrismaService } from '../prisma/prisma.service';
import { getDevSubscriptionInfo, isDevSkipSubscription } from '../config/dev.config';

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  isDevMode(): boolean {
    return isDevSkipSubscription();
  }

  getByUserId(userId: string) {
    return this.prisma.subscription.findUnique({ where: { userId } });
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
    return {
      plan: sharedPlan,
      status: sub.status as SubscriptionInfo['status'],
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      sttMinutesUsed: sub.sttMinutesUsed,
      llmTokensUsed: sub.llmTokensUsed,
      limits: PLAN_LIMITS[sharedPlan],
    };
  }

  async activateSubscription(
    userId: string,
    plan: Plan,
    provider: 'STRIPE' | 'YOOKASSA',
    externalId: string,
    periodEnd: Date,
  ) {
    return this.prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan,
        status: SubStatus.ACTIVE,
        provider,
        externalId,
        currentPeriodEnd: periodEnd,
        sttMinutesUsed: 0,
        llmTokensUsed: 0,
      },
      update: {
        plan,
        status: SubStatus.ACTIVE,
        provider,
        externalId,
        currentPeriodEnd: periodEnd,
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
}
