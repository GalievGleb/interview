/**
 * Клиент ЮKassa (YooKassa API v3) + прайс тарифов.
 *
 * Оплата — разовый платёж (не автосписание): покупатель платит за N дней
 * лицензии, срок кладётся в подписанный ключ (mintLicenseKey → expires_at).
 * Автопродление/сохранённый способ оплаты — отдельная большая история, здесь
 * сознательно не делаем.
 *
 * Конфиг — только через env (секретный ключ НИКОГДА не в коде/репозитории):
 *   YOOKASSA_SHOP_ID       — идентификатор магазина (напр. 1402744)
 *   YOOKASSA_SECRET_KEY    — секретный ключ из ЛК ЮKassa
 *   YOOKASSA_RETURN_URL    — куда вернуть после оплаты (страница успеха)
 *   YOOKASSA_SEND_RECEIPT  — "0" отключает чек (по умолчанию чек включён: 54-ФЗ)
 */

export type PlanId = 'basic' | 'max';
export type BillingPeriod = 'monthly' | 'yearly';

export interface PlanPricing {
  amountRub: number; // цена в рублях (источник истины — СЕРВЕР, клиенту не верим)
  days: number; // срок лицензии
  label: string; // описание для платежа и фискального чека
}

// Зеркалит apps/desktop/src/lib/billing.ts (год = 10 месяцев, 2 в подарок).
export const PLAN_PRICING: Record<PlanId, Record<BillingPeriod, PlanPricing>> = {
  basic: {
    monthly: { amountRub: 1490, days: 30, label: 'SkillCue «Базовый» — 1 месяц' },
    yearly: { amountRub: 14900, days: 365, label: 'SkillCue «Базовый» — 1 год' },
  },
  max: {
    monthly: { amountRub: 2990, days: 30, label: 'SkillCue «Максимум» — 1 месяц' },
    yearly: { amountRub: 29900, days: 365, label: 'SkillCue «Максимум» — 1 год' },
  },
};

const YOOKASSA_API = 'https://api.yookassa.ru/v3';

export function yookassaConfigured(): boolean {
  return Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
}

function authHeader(): string {
  const shopId = process.env.YOOKASSA_SHOP_ID ?? '';
  const secret = process.env.YOOKASSA_SECRET_KEY ?? '';
  return 'Basic ' + Buffer.from(`${shopId}:${secret}`).toString('base64');
}

function rub(amount: number): string {
  // ЮKassa требует строку с двумя знаками после запятой.
  return amount.toFixed(2);
}

export interface CreatePaymentInput {
  amountRub: number;
  description: string;
  returnUrl: string;
  email: string;
  metadata: Record<string, string>;
  idempotenceKey: string;
}

export interface YooPayment {
  id: string;
  status: string; // pending | waiting_for_capture | succeeded | canceled
  paid: boolean;
  confirmationUrl?: string;
  metadata?: Record<string, string>;
}

/** Создать платёж. Возвращает confirmation_url для редиректа на оплату. */
export async function createPayment(input: CreatePaymentInput): Promise<YooPayment> {
  const body: Record<string, unknown> = {
    amount: { value: rub(input.amountRub), currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: input.returnUrl },
    description: input.description.slice(0, 128),
    metadata: input.metadata,
  };
  // Фискальный чек (54-ФЗ). Для самозанятого ЮKassa отправляет его в «Мой налог».
  // Отключается YOOKASSA_SEND_RECEIPT=0, если фискализация настроена иначе.
  if (process.env.YOOKASSA_SEND_RECEIPT !== '0') {
    body.receipt = {
      customer: { email: input.email },
      items: [
        {
          description: input.description.slice(0, 128),
          quantity: '1.00',
          amount: { value: rub(input.amountRub), currency: 'RUB' },
          vat_code: 1, // без НДС (плательщик НПД)
          payment_subject: 'service',
          payment_mode: 'full_payment',
        },
      ],
    };
  }

  const res = await fetch(`${YOOKASSA_API}/payments`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Idempotence-Key': input.idempotenceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`YooKassa createPayment ${res.status}: ${text}`);
  }
  const data = (await res.json()) as {
    id: string;
    status: string;
    paid?: boolean;
    confirmation?: { confirmation_url?: string };
    metadata?: Record<string, string>;
  };
  return {
    id: data.id,
    status: data.status,
    paid: Boolean(data.paid),
    confirmationUrl: data.confirmation?.confirmation_url,
    metadata: data.metadata,
  };
}

/** Перечитать платёж по id — единственный источник правды об оплате
 * (телу вебхука не доверяем, всегда подтверждаем этим запросом). */
export async function getPayment(id: string): Promise<YooPayment> {
  const res = await fetch(`${YOOKASSA_API}/payments/${encodeURIComponent(id)}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) {
    throw new Error(`YooKassa getPayment ${res.status}`);
  }
  const data = (await res.json()) as {
    id: string;
    status: string;
    paid?: boolean;
    metadata?: Record<string, string>;
  };
  return { id: data.id, status: data.status, paid: Boolean(data.paid), metadata: data.metadata };
}
