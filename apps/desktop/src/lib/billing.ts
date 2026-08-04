/**
 * Тарифы и покупка. Оплата — через ЮKassa: кнопка «Оплатить» открывает в
 * браузере страницу оплаты skill-cue.ru/pay?plan=…&period=…, оттуда редирект на
 * ЮKassa. После оплаты сервер выпускает подписанный лицензионный ключ (гейтвей:
 * billing.service.ts), страница успеха показывает его, пользователь вставляет
 * ключ в Настройки → Лицензия. Приложению не нужен доступ к платёжке.
 *
 * Ручная выдача через Telegram-аккаунт @SkillCue и leadbot /key —
 * остаётся резервным каналом поддержки, но основной путь теперь ЮKassa.
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

// Страница оплаты на лендинге (ведёт на ЮKassa). Переопределяется на сборке
// через VITE_PAY_BASE, если домен другой.
const PAY_BASE = import.meta.env?.VITE_PAY_BASE ?? 'https://skill-cue.ru/pay';

export function checkoutUrl(plan: PlanId, period: BillingPeriod): string {
  const qs = new URLSearchParams({ plan, period });
  return `${PAY_BASE}?${qs.toString()}`;
}

export function formatRub(n: number): string {
  return `${n.toLocaleString('ru-RU')} ₽`;
}
