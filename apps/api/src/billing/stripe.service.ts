import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { BillingPeriod, Plan } from '@interview/shared';

@Injectable()
export class StripeService {
  private stripe: Stripe | null = null;

  private getClient(): Stripe {
    if (!this.stripe) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) {
        throw new Error('STRIPE_SECRET_KEY is not configured');
      }
      this.stripe = new Stripe(key);
    }
    return this.stripe;
  }

  getPriceId(plan: Plan, period: BillingPeriod): string {
    const suffix = period === BillingPeriod.YEARLY ? 'YEARLY' : 'MONTHLY';
    const priceId = process.env[`STRIPE_${plan}_${suffix}_PRICE_ID`]
      ?? (period === BillingPeriod.MONTHLY
        ? (plan === Plan.BASIC ? process.env.STRIPE_BASIC_PRICE_ID : process.env.STRIPE_PRO_PRICE_ID)
        : undefined);
    if (!priceId) {
      throw new Error(`Stripe price ID for plan ${plan} is not configured`);
    }
    return priceId;
  }

  async createCheckoutSession(
    userId: string,
    email: string,
    plan: Plan,
    period: BillingPeriod,
    successUrl: string,
    cancelUrl: string,
  ): Promise<string> {
    const stripe = this.getClient();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: this.getPriceId(plan, period), quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { userId, email, plan, durationDays: period === BillingPeriod.YEARLY ? '365' : '30' },
    });
    if (!session.url) {
      throw new Error('Failed to create Stripe checkout session');
    }
    return session.url;
  }

  constructEvent(payload: Buffer, signature: string): Stripe.Event {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }
    return this.getClient().webhooks.constructEvent(payload, signature, secret);
  }
}
