import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../lib/i18n';
import {
  PLANS,
  checkoutUrl,
  formatRub,
  type BillingPeriod,
  type PlanId,
} from '../lib/billing';

/**
 * Выбор тарифа (по мотивам «Choose your plan» Cluely, в нашем стиле).
 * Оплата открывается в браузере; ключ приходит на почту и активируется
 * в карточке «Лицензия» ниже — приложению не нужен доступ к платёжке.
 */
export default function PlanPicker() {
  const { license } = useApp();
  const { t } = useI18n();
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [confirmPlan, setConfirmPlan] = useState<PlanId | null>(null);

  const currentPlan = license?.status === 'active' ? license.plan : null;

  const openCheckout = (plan: PlanId) => {
    const url = checkoutUrl(plan, period);
    if (window.electronAPI) void window.electronAPI.openExternal(url);
    else window.open(url, '_blank', 'noopener');
    setConfirmPlan(null);
  };

  return (
    <div className="sc-card mb-5 p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">{t('plan.title')}</h3>
          <p className="mt-0.5 text-xs text-ink-faint">
            {currentPlan
              ? `${t('plan.current')} ${currentPlan === 'max' ? t('plan.max') : t('plan.basic')}`
              : t('plan.trialInfo')}
          </p>
        </div>
        <div className="sc-segmented" role="group" aria-label={t('plan.periodAria')}>
          {(
            [
              ['monthly', t('plan.monthly')],
              ['yearly', t('plan.yearly')],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setPeriod(id)}
              className={`sc-segmented__item ${period === id ? 'sc-segmented__item--active' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {PLANS.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          const price = period === 'monthly' ? plan.monthlyRub : plan.yearlyRub;
          return (
            <div
              key={plan.id}
              className={`relative rounded-2xl border p-4 ${
                plan.popular
                  ? 'border-accent/50 bg-accent-soft'
                  : 'border-surface-border bg-surface-light/60'
              }`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-[13px] font-semibold text-ink">{t(plan.nameKey)}</p>
                {isCurrent ? (
                  <span className="sc-badge sc-badge--success">{t('plan.currentBadge')}</span>
                ) : plan.popular ? (
                  <span className="sc-badge sc-badge--accent">{t('plan.popular')}</span>
                ) : null}
              </div>
              <p className="mb-3">
                <span className="text-2xl font-bold text-ink">{formatRub(price)}</span>
                <span className="text-xs text-ink-faint">
                  {period === 'monthly' ? t('plan.perMonth') : t('plan.perYear')}
                </span>
              </p>
              <p className="mb-3 text-xs leading-relaxed text-ink-muted">
                {t(plan.id === 'basic' ? 'billing.plan.basic.summary' : 'billing.plan.max.summary')}
              </p>
              <ul className="mb-4 space-y-1.5">
                {plan.features.map((f) => (
                  <li
                    key={f.textKey}
                    className={`flex items-start gap-2 text-xs ${
                      f.included ? 'text-ink-muted' : 'text-ink-faint'
                    }`}
                  >
                    <span className={f.included ? 'text-accent' : 'text-ink-faint'}>
                      {f.included ? '✓' : '×'}
                    </span>
                    {t(f.textKey)}
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <button type="button" className="btn-secondary btn-sm w-full" disabled>
                  {t('plan.yourCurrent')}
                </button>
              ) : confirmPlan === plan.id ? (
                <div className="rounded-xl border border-surface-border bg-surface-panel p-3">
                  <p className="mb-2 text-[11.5px] leading-snug text-ink-muted">
                    {t('plan.checkoutNote')}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-primary btn-sm flex-1"
                      onClick={() => openCheckout(plan.id)}
                    >
                      {t('plan.goToCheckout')}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => setConfirmPlan(null)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={`btn-sm w-full ${plan.popular ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setConfirmPlan(plan.id)}
                >
                  {currentPlan ? t('plan.switch') : t('plan.subscribe')}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
