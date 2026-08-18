import { Injectable } from '@nestjs/common';
import { Plan } from '@interview/shared';
import { v4 as uuidv4 } from 'uuid';

interface YooKassaPaymentResponse {
  id: string;
  status: string;
  confirmation?: { confirmation_url?: string };
}

// Prices mirror yookassa.util.ts (the active billing module). The old billing
// module is kept for Stripe compatibility; these values must stay in sync.
const PLAN_PRICES_RUB: Record<Plan, number> = {
  [Plan.PRO]: 2990,
};

@Injectable()
export class YookassaService {
  private getAuthHeader(): string {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;
    if (!shopId || !secretKey) {
      throw new Error('YooKassa credentials are not configured');
    }
    return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
  }

  async createPayment(
    userId: string,
    email: string,
    plan: Plan,
    returnUrl: string,
  ): Promise<string> {
    const idempotenceKey = uuidv4();
    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey,
      },
      body: JSON.stringify({
        amount: { value: PLAN_PRICES_RUB[plan].toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: returnUrl },
        description: `Interview Assistant ${plan} subscription`,
        metadata: { userId, plan },
        receipt: {
          customer: { email },
          items: [
            {
              description: `Interview Assistant ${plan}`,
              quantity: '1.00',
              amount: { value: PLAN_PRICES_RUB[plan].toFixed(2), currency: 'RUB' },
              vat_code: 1,
            },
          ],
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`YooKassa error: ${text}`);
    }

    const data = (await response.json()) as YooKassaPaymentResponse;
    const url = data.confirmation?.confirmation_url;
    if (!url) {
      throw new Error('Failed to create YooKassa payment');
    }
    return url;
  }

  /**
   * Re-read a payment from the YooKassa API. This is the single source of
   * truth about whether a payment really succeeded — the webhook body is
   * unsigned and must never be trusted on its own.
   */
  async getPayment(paymentId: string): Promise<{ status: string; paid: boolean }> {
    const response = await fetch(
      `https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: this.getAuthHeader() } },
    );
    if (!response.ok) {
      throw new Error(`YooKassa getPayment ${response.status}`);
    }
    const data = (await response.json()) as { status?: string; paid?: boolean };
    return { status: data.status ?? '', paid: Boolean(data.paid) };
  }

  verifyWebhookIp(_ip: string): boolean {
    // Kept for API compatibility; IP allow-listing is unreliable behind a
    // proxy and payment correctness is enforced by getPayment() re-verification
    // instead of by the notification source.
    return true;
  }
}
