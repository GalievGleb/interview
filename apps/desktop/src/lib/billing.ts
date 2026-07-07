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

export type PlanId = 'basic' | 'max';
export type BillingPeriod = 'monthly' | 'yearly';

export interface PlanInfo {
  id: PlanId;
  name: string;
  monthlyRub: number;
  /** Год = 10 месяцев (2 в подарок). */
  yearlyRub: number;
  features: Array<{ text: string; included: boolean }>;
  popular?: boolean;
}

export const PLANS: PlanInfo[] = [
  {
    id: 'basic',
    name: 'Базовый — подготовка',
    monthlyRub: 1490,
    yearlyRub: 14900,
    features: [
      { text: 'Мок-собеседования с разбором', included: true },
      { text: 'Анализ вакансий и слабых тем', included: true },
      { text: 'База знаний и тренировка ответов', included: true },
      { text: 'Месячный объём ИИ для подготовки', included: true },
      { text: 'Live-подсказки и оверлей', included: false },
      { text: 'Анализ экрана и скрытность', included: false },
    ],
  },
  {
    id: 'max',
    name: 'Максимум — всё включено',
    monthlyRub: 2990,
    yearlyRub: 29900,
    popular: true,
    features: [
      { text: 'Всё из «Базового»', included: true },
      { text: 'Live-подсказки во время собеседования', included: true },
      { text: 'Оверлей поверх Zoom/Meet + скрытность', included: true },
      { text: 'Анализ экрана (скриншот → подсказка)', included: true },
      { text: 'Увеличенный объём ИИ — хватит на активный поиск', included: true },
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
