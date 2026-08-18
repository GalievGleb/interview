import { Injectable, BadRequestException } from '@nestjs/common';
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
  constructor(
    private readonly stripeService: StripeService,
    private readonly yookassaService: YookassaService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly prisma: PrismaService,
  ) {}

  async createCheckout(userId: string, email: string, dto: CheckoutDto) {
    const successUrl =
      dto.successUrl ?? `${process.env.DESKTOP_PROTOCOL ?? 'interview'}://payment-success`;
    const cancelUrl = dto.cancelUrl ?? `${process.env.DESKTOP_PROTOCOL ?? 'interview'}://payment-cancel`;

    if (dto.provider === BillingProvider.STRIPE) {
      const checkoutUrl = await this.stripeService.createCheckoutSession(
        userId,
        email,
        dto.plan,
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
        successUrl,
      );
      return { checkoutUrl };
    }

    throw new BadRequestException('Unsupported billing provider');
  }

  async handleStripeWebhook(payload: Buffer, signature: string) {
    const event = this.stripeService.constructEvent(payload, signature);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      await this.processStripeCheckout(session);
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as Stripe.Subscription;
      await this.expireByExternalId(subscription.id);
    }

    await this.recordEvent(PaymentProvider.STRIPE, event.id, event);
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

    let verified: { status: string; paid: boolean } | null = null;
    try {
      verified = await this.yookassaService.getPayment(paymentId);
    } catch (err) {
      this.logger?.error?.(`YooKassa webhook verification failed: ${err}`);
      return;
    }

    if (!verified || verified.status !== 'succeeded' || !verified.paid) {
      return; // not paid — do not activate
    }

    const metadata = object.metadata as { userId?: string; plan?: string } | undefined;
    const userId = metadata?.userId;
    const plan = metadata?.plan as Plan | undefined;
    if (userId && plan) {
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      await this.subscriptionsService.activateSubscription(
        userId,
        plan as PrismaPlan,
        PaymentProvider.YOOKASSA,
        String(object.id),
        periodEnd,
      );
    }

    await this.recordEvent(PaymentProvider.YOOKASSA, String(object?.id ?? 'unknown'), body);
  }

  private async processStripeCheckout(session: Stripe.Checkout.Session) {
    const userId = session.metadata?.userId;
    const plan = session.metadata?.plan as Plan | undefined;
    if (!userId || !plan) {
      return;
    }

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await this.subscriptionsService.activateSubscription(
      userId,
      plan as PrismaPlan,
      PaymentProvider.STRIPE,
      String(session.subscription ?? session.id),
      periodEnd,
    );
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

  private async recordEvent(provider: PaymentProvider, externalId: string, payload: unknown) {
    await this.prisma.paymentEvent.upsert({
      where: { provider_externalId: { provider, externalId } },
      create: { provider, externalId, payload: payload as object, processed: true },
      update: { processed: true, payload: payload as object },
    });
  }
}
