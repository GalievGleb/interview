/**
 * Платежи ЮKassa → выпуск лицензии.
 *
 * Поток:
 *  1. POST /gateway/checkout — создаём платёж, отдаём confirmation_url (редирект
 *     на оплату). Запись платежа кладём в Redis как pending.
 *  2. Покупатель платит. ЮKassa шлёт вебхук payment.succeeded → issueForPayment:
 *     ПЕРЕПРОВЕРЯЕМ платёж запросом к API (телу вебхука не доверяем), выпускаем
 *     подписанный ключ, сохраняем его на paymentId.
 *  3. Страница успеха опрашивает GET /gateway/checkout/status?payment=… и, как
 *     только ключ готов, показывает его. status тоже перепроверяет ЮKassa —
 *     значит выдача работает, даже если вебхук опоздал или не дошёл.
 *
 * Идемпотентность: ключ выпускается на платёж один раз (повторный вызов вернёт
 * уже сохранённый ключ, а не выпустит новый).
 */
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { mintLicenseKey, normalizePlan } from './license.util';
import {
  BillingPeriod,
  PLAN_PRICING,
  PlanId,
  createPayment,
  getPayment,
  yookassaConfigured,
} from './yookassa.util';

interface PaymentRecord {
  plan: PlanId;
  period: BillingPeriod;
  email: string;
  days: number;
  status: string; // pending | succeeded | <статус ЮKassa>
  key?: string;
}

export interface CheckoutResult {
  paymentId: string;
  confirmationUrl: string;
}

export interface StatusResult {
  status: string;
  key?: string;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');
  private static readonly RECORD_TTL_S = 60 * 60 * 24 * 3; // 3 дня — окно на дооплату/поллинг

  constructor(private readonly redis: RedisService) {}

  private recordKey(paymentId: string): string {
    return `gw:pay:${paymentId}`;
  }

  private async loadRecord(paymentId: string): Promise<PaymentRecord | null> {
    const raw = await this.redis.getClient().get(this.recordKey(paymentId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PaymentRecord;
    } catch {
      return null;
    }
  }

  private async saveRecord(paymentId: string, record: PaymentRecord): Promise<void> {
    await this.redis
      .getClient()
      .set(this.recordKey(paymentId), JSON.stringify(record), 'EX', BillingService.RECORD_TTL_S);
  }

  /** Создать платёж и вернуть ссылку на оплату. Сумму и срок берём СЕРВЕРНО. */
  async createCheckout(
    plan: PlanId,
    period: BillingPeriod,
    email: string,
  ): Promise<CheckoutResult> {
    if (!yookassaConfigured()) {
      throw new HttpException(
        { error: { message: 'Оплата временно недоступна', code: 'billing_unconfigured' } },
        503,
      );
    }
    const pricing = PLAN_PRICING[plan]?.[period];
    if (!pricing) {
      throw new HttpException(
        { error: { message: 'Неизвестный тариф или период', code: 'bad_plan' } },
        400,
      );
    }
    const returnUrl = process.env.YOOKASSA_RETURN_URL ?? 'https://skill-cue.ru/pay-success.html';
    const payment = await createPayment({
      amountRub: pricing.amountRub,
      description: pricing.label,
      returnUrl,
      email,
      metadata: { plan, period, email, days: String(pricing.days) },
      idempotenceKey: randomUUID(),
    });
    if (!payment.confirmationUrl) {
      throw new HttpException(
        { error: { message: 'ЮKassa не вернула ссылку на оплату', code: 'billing_error' } },
        502,
      );
    }
    await this.saveRecord(payment.id, {
      plan,
      period,
      email,
      days: pricing.days,
      status: 'pending',
    });
    this.logger.log(`Checkout ${payment.id}: ${plan}/${period} ${pricing.amountRub}₽ <${email}>`);
    return { paymentId: payment.id, confirmationUrl: payment.confirmationUrl };
  }

  /** Обработка вебхука ЮKassa. Реагируем только на успешную оплату. */
  async handleWebhook(body: Record<string, unknown>): Promise<void> {
    const event = body?.event;
    const obj = body?.object as { id?: string } | undefined;
    if (event !== 'payment.succeeded' || !obj?.id) return; // прочие события игнорим
    try {
      await this.issueForPayment(obj.id);
    } catch (e) {
      // Не бросаем наружу: вебхуку всегда отвечаем 200, иначе ЮKassa зашлёт
      // ретраи. Невыданный ключ подхватит поллинг статуса (тоже перепроверит).
      this.logger.error(`Webhook issue failed for ${obj.id}: ${e}`);
    }
  }

  /**
   * Идемпотентно выпустить лицензию по оплаченному платежу. ВСЕГДА перепроверяет
   * статус в ЮKassa — подделать успешную оплату через вебхук нельзя.
   */
  async issueForPayment(paymentId: string): Promise<StatusResult> {
    const record = await this.loadRecord(paymentId);
    if (record?.status === 'succeeded' && record.key) {
      return { status: 'succeeded', key: record.key };
    }

    const payment = await getPayment(paymentId);
    if (payment.status !== 'succeeded' || !payment.paid) {
      // Обновим статус в записи (если она есть), ключ не выпускаем.
      if (record) await this.saveRecord(paymentId, { ...record, status: payment.status });
      return { status: payment.status };
    }

    const meta = { ...(record ?? {}), ...(payment.metadata ?? {}) } as Partial<PaymentRecord> &
      Record<string, unknown>;
    // trial не продаётся; неизвестное трактуем в пользу покупателя (normalizePlan → max).
    const rawPlan = String((meta.plan as string) ?? 'max');
    const plan: PlanId = normalizePlan(rawPlan) === 'basic' ? 'basic' : 'max';
    const email = String((meta.email as string) ?? 'unknown@skill-cue.ru');
    const days = Number(meta.days ?? 30) || 30;

    const privateKeyHex = process.env.LICENSE_PRIVATE_KEY_HEX ?? '';
    if (!privateKeyHex) {
      throw new HttpException(
        { error: { message: 'LICENSE_PRIVATE_KEY_HEX is not set', code: 'gateway_unconfigured' } },
        503,
      );
    }
    const key = mintLicenseKey({ email, plan, days }, privateKeyHex);
    await this.saveRecord(paymentId, {
      plan,
      period: (meta.period as BillingPeriod) ?? 'monthly',
      email,
      days,
      status: 'succeeded',
      key,
    });
    this.logger.log(`License issued for payment ${paymentId}: ${plan}, ${days}d <${email}>`);
    return { status: 'succeeded', key };
  }

  /**
   * Статус для страницы успеха. Если ключа ещё нет — перепроверяем ЮKassa, чтобы
   * выдать ключ даже при опоздавшем/потерянном вебхуке.
   */
  async status(paymentId: string): Promise<StatusResult> {
    if (!paymentId) return { status: 'unknown' };
    const record = await this.loadRecord(paymentId);
    if (record?.status === 'succeeded' && record.key) {
      return { status: 'succeeded', key: record.key };
    }
    try {
      return await this.issueForPayment(paymentId);
    } catch (e) {
      this.logger.error(`Status check failed for ${paymentId}: ${e}`);
      return { status: record?.status ?? 'pending' };
    }
  }
}
