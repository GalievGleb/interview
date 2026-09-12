import assert from 'node:assert/strict';
import test from 'node:test';
import { BillingService } from './billing.service';

function fixture(event: Record<string, unknown>) {
  let paymentEvent: { processed: boolean; processingAt: Date | null } | null = null;
  const activations: string[] = [];
  const pendingActivations: string[] = [];
  const prisma = {
    paymentEvent: {
      upsert: async () => {
        paymentEvent ??= { processed: false, processingAt: null };
        return paymentEvent;
      },
      updateMany: async () => {
        if (!paymentEvent || paymentEvent.processed || paymentEvent.processingAt) return { count: 0 };
        paymentEvent.processingAt = new Date();
        return { count: 1 };
      },
      update: async () => {
        if (!paymentEvent) throw new Error('missing event');
        paymentEvent.processed = true;
        paymentEvent.processingAt = null;
        return paymentEvent;
      },
    },
    subscription: {},
  };
  const stripe = { constructEvent: () => event };
  const yookassa = { getPayment: async () => ({ status: 'succeeded', paid: true }) };
  const subscriptions = {
    activateSubscription: async (_userId: string, _plan: string, _provider: string, externalId: string) => {
      activations.push(externalId);
    },
    activateForEmail: async (_email: string, _plan: string, _provider: string, externalId: string) => {
      pendingActivations.push(externalId);
    },
  };
  return {
    service: new BillingService(stripe as never, yookassa as never, subscriptions as never, prisma as never),
    activations,
    pendingActivations,
  };
}

test('a replayed Stripe payment event activates the subscription only once', async () => {
  const state = fixture({
    id: 'evt-1',
    type: 'checkout.session.completed',
    data: { object: { id: 'checkout-1', subscription: 'sub-1', metadata: { userId: 'user-1', plan: 'BASIC' } } },
  });

  await state.service.handleStripeWebhook(Buffer.from('{}'), 'valid-signature');
  await state.service.handleStripeWebhook(Buffer.from('{}'), 'valid-signature');

  assert.deepEqual(state.activations, ['sub-1']);
});

test('a verified Stripe payment can be held by email until registration', async () => {
  const state = fixture({
    id: 'evt-2',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'checkout-2',
        metadata: { plan: 'PRO' },
        customer_details: { email: ' Buyer@Example.COM ' },
      },
    },
  });

  await state.service.handleStripeWebhook(Buffer.from('{}'), 'valid-signature');

  assert.deepEqual(state.pendingActivations, ['checkout-2']);
});

test('checkout refuses a paid downgrade that the subscription model cannot represent', async () => {
  let checkoutCalled = false;
  const service = new BillingService(
    { createCheckoutSession: async () => { checkoutCalled = true; return 'https://checkout.test'; } } as never,
    {} as never,
    {
      getByUserId: async () => ({
        plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 86_400_000),
      }),
    } as never,
    {} as never,
  );

  await assert.rejects(
    () => service.createCheckout('user-1', 'person@example.com', {
      plan: 'BASIC' as never,
      provider: 'stripe' as never,
      period: 'monthly' as never,
    }),
    /SUBSCRIPTION_DOWNGRADE_NOT_SUPPORTED/,
  );
  assert.equal(checkoutCalled, false);
});

test('checkout never forwards an untrusted payment return URL', async () => {
  const service = new BillingService(
    { createCheckoutSession: async () => 'https://checkout.test' } as never,
    {} as never,
    { getByUserId: async () => null } as never,
    {} as never,
  );

  await assert.rejects(
    () => service.createCheckout('user-1', 'person@example.com', {
      plan: 'PRO' as never,
      provider: 'stripe' as never,
      period: 'monthly' as never,
      successUrl: 'https://evil.example/phish',
      cancelUrl: 'https://skill-cue.ru/account-payment-cancel.html?channel=alpha',
    }),
    /CHECKOUT_RETURN_URL_INVALID/,
  );
});
