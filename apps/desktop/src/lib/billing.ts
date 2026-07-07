/**
 * Тарифы и покупка. Оплата на RU-старте — через Telegram-бота:
 * кнопка «Оплатить» открывает @SkillCue_support_bot с deep-link'ом плана,
 * бот присылает реквизиты, после оплаты админ выдаёт лицензионный ключ
 * (leadbot: /key), пользователь активирует его в настройках. Ключей API
 * в приложении нет.
 *
 * Для EN-экспансии вернуть внешний checkout (LemonSqueezy) — вебхук уже
 * готов: apps/api-py/tools/license_webhook.py.
 */

import type { I18nKey } from './i18n';

export type PlanId = 'basic' | 'max';
export type BillingPeriod = 'monthly' | 'yearly';

export interface PlanInfo {
  id: PlanId;
  nameKey: I18nKey;
  monthlyRub: number;
  /** Год = 10 месяцев (2 в подарок). */
  yearlyRub: number;
  features: Array<{ textKey: I18nKey; included: boolean }>;
  popular?: boolean;
}

export const PLANS: PlanInfo[] = [
  {
    id: 'basic',
    nameKey: 'billing.plan.basic.name',
    monthlyRub: 1490,
    yearlyRub: 14900,
    features: [
      { textKey: 'billing.feat.mock', included: true },
      { textKey: 'billing.feat.vacancy', included: true },
      { textKey: 'billing.feat.kb', included: true },
      { textKey: 'billing.feat.aiPrep', included: true },
      { textKey: 'billing.feat.live', included: false },
      { textKey: 'billing.feat.screen', included: false },
    ],
  },
  {
    id: 'max',
    nameKey: 'billing.plan.max.name',
    monthlyRub: 2990,
    yearlyRub: 29900,
    popular: true,
    features: [
      { textKey: 'billing.feat.allBasic', included: true },
      { textKey: 'billing.feat.liveDuring', included: true },
      { textKey: 'billing.feat.overlay', included: true },
      { textKey: 'billing.feat.screenshot', included: true },
      { textKey: 'billing.feat.aiMax', included: true },
    ],
  },
];

const SALES_BOT = 'https://t.me/SkillCue_support_bot';

const CHECKOUT_URLS: Record<PlanId, Record<BillingPeriod, string>> = {
  basic: {
    monthly: `${SALES_BOT}?start=buy_basic_monthly`,
    yearly: `${SALES_BOT}?start=buy_basic_yearly`,
  },
  max: {
    monthly: `${SALES_BOT}?start=buy_max_monthly`,
    yearly: `${SALES_BOT}?start=buy_max_yearly`,
  },
};

export function checkoutUrl(plan: PlanId, period: BillingPeriod): string {
  return CHECKOUT_URLS[plan][period];
}

export function formatRub(n: number): string {
  return `${n.toLocaleString('ru-RU')} ₽`;
}
