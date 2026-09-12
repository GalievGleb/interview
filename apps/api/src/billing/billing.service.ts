import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Plan, BillingProvider } from '@interview/shared';
import { Plan as PrismaPlan, PaymentProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { StripeService } from './stripe.service';
import { YookassaService } from './yookassa.service';
import { CheckoutDto } from './dto/checkout.dto';
import Stripe from 'stripe';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly yookassaService: YookassaService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly prisma: PrismaService,
  ) {}

  async createCheckout(userId: string, email: string, dto: CheckoutDto) {
    const current = await this.subscriptionsService.getByUserId(userId);
    if (
      current?.status === 'ACTIVE' && current.plan === PrismaPlan.PRO &&
      current.currentPeriodEnd && current.currentPeriodEnd > new Date() &&
      dto.plan === Plan.BASIC
    ) {
      throw new BadRequestException('SUBSCRIPTION_DOWNGRADE_NOT_SUPPORTED');
    }
    const successUrl = this.paymentReturnUrl(dto.successUrl, 'success');
    const cancelUrl = this.paymentReturnUrl(dto.cancelUrl, 'cancel');

    if (dto.provider === BillingProvider.STRIPE) {
      const checkoutUrl = await this.stripeService.createCheckoutSession(
        userId,
        email,
        dto.plan,
        dto.period,
        successUrl,
        cancelUrl,
      );
      return { checkoutUrl };
    }

    if (dto.provider === BillingProvider.YOOKASSA) {
      const checkoutUrl = await this.yookassaService.createPayment(
        userId,
        email,
        dto.plan,
        dto.period,
        successUrl,
      );
      return { checkoutUrl };
    }

    throw new BadRequestException('Unsupported billing provider');
  }

  async handleStripeWebhook(payload: Buffer, signature: string) {
    const event = this.stripeService.constructEvent(payload, signature);
    if (!await this.claimEvent(PaymentProvider.STRIPE, event.id, event)) return;

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        await this.processStripeCheckout(session);
      }

      if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object as Stripe.Subscription;
        await this.expireByExternalId(subscription.id);
      }

      await this.completeEvent(PaymentProvider.STRIPE, event.id, event);
    } catch (error) {
      await this.releaseEvent(PaymentProvider.STRIPE, event.id);
      throw error;
    }
  }

  async handleYookassaWebhook(body: Record<string, unknown>) {
    const event = body.event as string;
    const object = body.object as Record<string, unknown>;

    // Security: never trust the webhook body. YooKassa delivers unsigned
    // notifications, so a forged POST here would otherwise activate a paid
    // subscription for free. Re-verify the payment against the YooKassa API
    // before activating; only `paid === true` and `status === 'succeeded'`
    // count. The failure path is safe: we simply do not activate.
    if (event !== 'payment.succeeded') return;

    const paymentId = typeof object?.id === 'string' ? object.id : '';
    if (!paymentId) return;

    let verified: {
      status: string;
      paid: boolean;
      metadata?: { userId?: string; email?: string; plan?: string; durationDays?: string };
    } | null = null;
    try {
      verified = await this.yookassaService.getPayment(paymentId);
    } catch (err) {
      this.logger?.error?.(`YooKassa webhook verification failed: ${err}`);
      return;
    }

    if (!verified || verified.status !== 'succeeded' || !verified.paid) {
      return; // not paid — do not activate
    }

    if (!await this.claimEvent(PaymentProvider.YOOKASSA, paymentId, body)) return;

    const metadata = verified.metadata;
    const userId = metadata?.userId;
    const email = metadata?.email;
    const plan = metadata?.plan as Plan | undefined;
    const durationDays = this.durationDays(metadata?.durationDays);
    try {
      if (userId && plan) {
        const periodEnd = this.periodEndFromDays(durationDays);
        await this.subscriptionsService.activateSubscription(
          userId,
          plan as PrismaPlan,
          PaymentProvider.YOOKASSA,
          paymentId,
          periodEnd,
        );
      } else if (email && plan) {
        await this.subscriptionsService.activateForEmail(
          email,
          plan as PrismaPlan,
          PaymentProvider.YOOKASSA,
          paymentId,
          durationDays,
        );
      }

      await this.completeEvent(PaymentProvider.YOOKASSA, paymentId, body);
    } catch (error) {
      await this.releaseEvent(PaymentProvider.YOOKASSA, paymentId);
      throw error;
    }
  }

  private async processStripeCheckout(session: Stripe.Checkout.Session) {
    const userId = session.metadata?.userId;
    const email = session.customer_details?.email ?? session.customer_email ?? session.metadata?.email;
    const plan = session.metadata?.plan as Plan | undefined;
    const durationDays = this.durationDays(session.metadata?.durationDays);
    if (!plan) return;

    const externalId = String(session.subscription ?? session.id);
    if (userId) {
      await this.subscriptionsService.activateSubscription(
        userId,
        plan as PrismaPlan,
        PaymentProvider.STRIPE,
        externalId,
        this.periodEndFromDays(durationDays),
      );
    } else if (email) {
      await this.subscriptionsService.activateForEmail(
        email,
        plan as PrismaPlan,
        PaymentProvider.STRIPE,
        externalId,
        durationDays,
      );
    }
  }

  private async expireByExternalId(externalId: string) {
    const sub = await this.prisma.subscription.findFirst({ where: { externalId } });
    if (sub) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'EXPIRED' },
      });
    }
  }

  private async claimEvent(provider: PaymentProvider, externalId: string, payload: unknown) {
    await this.prisma.paymentEvent.upsert({
      where: { provider_externalId: { provider, externalId } },
      create: { provider, externalId, payload: payload as object },
      update: { payload: payload as object },
    });
    const staleBefore = new Date(Date.now() - 5 * 60_000);
    const claimed = await this.prisma.paymentEvent.updateMany({
      where: {
        provider,
        externalId,
        processed: false,
        OR: [{ processingAt: null }, { processingAt: { lt: staleBefore } }],
      },
      data: { processingAt: new Date() },
    });
    return claimed.count === 1;
  }

  private async completeEvent(provider: PaymentProvider, externalId: string, payload: unknown) {
    await this.prisma.paymentEvent.update({
      where: { provider_externalId: { provider, externalId } },
      data: { processed: true, processingAt: null, payload: payload as object },
    });
  }

  private async releaseEvent(provider: PaymentProvider, externalId: string) {
    await this.prisma.paymentEvent.update({
      where: { provider_externalId: { provider, externalId } },
      data: { processingAt: null },
    });
  }

  private periodEndFromDays(durationDays: number): Date {
    const periodEnd = new Date();
    periodEnd.setUTCDate(periodEnd.getUTCDate() + durationDays);
    return periodEnd;
  }

  private durationDays(raw: string | undefined): 30 | 365 {
    return raw === '365' ? 365 : 30;
  }

  private paymentReturnUrl(raw: string | undefined, result: 'success' | 'cancel'): string {
    const fallback = `https://skill-cue.ru/account-payment-${result}.html?channel=alpha`;
    let url: URL;
    try {
      url = new URL(raw ?? fallback);
    } catch {
      throw new BadRequestException('CHECKOUT_RETURN_URL_INVALID');
    }
    const allowedHost = url.hostname === 'skill-cue.ru' || url.hostname === 'www.skill-cue.ru';
    const allowedPath = url.pathname === `/account-payment-${result}.html`;
    const channel = url.searchParams.get('channel');
    if (
      url.protocol !== 'https:' || !allowedHost || !allowedPath ||
      (channel !== 'alpha' && channel !== 'dev')
    ) {
      throw new BadRequestException('CHECKOUT_RETURN_URL_INVALID');
    }
    return url.toString();
  }
}
