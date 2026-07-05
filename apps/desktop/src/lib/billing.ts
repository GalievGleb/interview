/**
 * Тарифы и покупка. Оплата — через внешний checkout (LemonSqueezy):
 * приложение открывает страницу оплаты в браузере, после оплаты вебхук
 * (tools/license_webhook.py) отправляет лицензионный ключ на почту,
 * пользователь активирует его в настройках. Ключей API в приложении нет.
 *
 * ЗАМЕНИТЬ ссылки на реальные checkout-URL после создания продуктов
 * в LemonSqueezy (Store → Products → Share → Checkout link).
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
      { text: '5 млн токенов ИИ в месяц', included: true },
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
      { text: '20 млн токенов ИИ в месяц', included: true },
    ],
  },
];

const CHECKOUT_URLS: Record<PlanId, Record<BillingPeriod, string>> = {
  basic: {
    monthly: 'https://skillcue.lemonsqueezy.com/buy/basic-monthly',
    yearly: 'https://skillcue.lemonsqueezy.com/buy/basic-yearly',
  },
  max: {
    monthly: 'https://skillcue.lemonsqueezy.com/buy/max-monthly',
    yearly: 'https://skillcue.lemonsqueezy.com/buy/max-yearly',
  },
};

export function checkoutUrl(plan: PlanId, period: BillingPeriod): string {
  return CHECKOUT_URLS[plan][period];
}

export function formatRub(n: number): string {
  return `${n.toLocaleString('ru-RU')} ₽`;
}
