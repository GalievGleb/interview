import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';
import { useI18n, type I18nKey } from '../lib/i18n';

const PLAN_LABEL_KEYS: Record<string, I18nKey> = {
  trial: 'license.plan.trial',
  basic: 'license.plan.basic',
  max: 'license.plan.max',
};

/** Лицензия: 15-мин live-trial, тариф, месячный токен-бюджет + активация ключа.
 *
 * `autoActivateKey` приходит по deep-link skillcue://activate?key=… (после оплаты
 * на сайте) — активируем его автоматически с тем же фидбэком, что и ручной ввод,
 * в любом статусе (в т.ч. апгрейд basic→max). */
export default function LicenseCard({ autoActivateKey }: { autoActivateKey?: string }) {
  const { license, refreshLicense } = useApp();
  const { t } = useI18n();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const autoDone = useRef<string | null>(null);

  const planLabel = useCallback(
    (plan: string) => (PLAN_LABEL_KEYS[plan] ? t(PLAN_LABEL_KEYS[plan]) : plan),
    [t],
  );

  const activateKey = useCallback(
    async (raw: string) => {
      const k = raw.trim();
      if (!k) return;
      setBusy(true);
      setError('');
      setMessage('');
      try {
        const res = await api.activateLicense(k);
        setMessage(`${t('license.activated')} (${planLabel(res.plan)})`);
        setKey('');
        await refreshLicense();
      } catch (err) {
        setError(err instanceof Error ? err.message : t('license.activateError'));
      } finally {
        setBusy(false);
      }
    },
    [planLabel, refreshLicense, t],
  );

  // Активация по deep-link — ровно один раз на каждый пришедший ключ.
  useEffect(() => {
    if (autoActivateKey && autoDone.current !== autoActivateKey) {
      autoDone.current = autoActivateKey;
      void activateKey(autoActivateKey);
    }
  }, [autoActivateKey, activateKey]);

  const minutesLeft =
    license?.live_seconds_left != null ? Math.ceil(license.live_seconds_left / 60) : null;

  const badge =
    license?.status === 'active' ? (
      <span className="sc-badge sc-badge--success">
        <span className="sc-dot sc-dot--success" /> {planLabel(license.plan)}
      </span>
    ) : license?.status === 'trial' ? (
      <span className="sc-badge sc-badge--accent">
        {t('license.trialLeftPre')} {minutesLeft} {t('license.trialLeftPost')}
      </span>
    ) : license ? (
      <span className="sc-badge sc-badge--error">{t('license.trialEnded')}</span>
    ) : null;

  const statusText =
    license?.status === 'active' ? (
      <>
        {t('license.issuedTo')} <span className="text-ink">{license.licensed_to}</span>.
        {license.plan === 'basic' && t('license.basicUpsell')}
      </>
    ) : license?.status === 'trial' ? (
      t('license.trialPrompt')
    ) : license ? (
      t('license.expiredPrompt')
    ) : (
      t('license.keyPrompt')
    );

  return (
    <div className="sc-card mb-5 p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">{t('license.title')}</h3>
        {badge}
      </div>

      <p className="mb-3 text-sm text-ink-muted">{statusText}</p>
      {license?.status === 'active' && (
        <p className="mb-3 text-sm text-ink-muted">{t('license.keyPrompt')}</p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="SKILLCUE-…"
          className="field flex-1 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => void activateKey(key)}
          disabled={busy || !key.trim()}
          className="btn-primary btn-sm shrink-0"
        >
          {busy ? t('common.checking') : t('license.activate')}
        </button>
      </div>

      {/* Результат активации (ручной или по deep-link) — виден в любом статусе,
          чтобы фидбэк не терялся при апгрейде уже активной лицензии. */}
      {message && <p className="mt-2 text-xs text-emerald-400">{message}</p>}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      {license?.plan === 'trial' && (
        <p className="mt-4 text-xs text-ink-muted">
          Осталось токенов: <strong className="text-ink">{Math.max(0, license.tokens_left_month).toLocaleString('ru-RU')}</strong>
          {' '}из {license.tokens_budget_month.toLocaleString('ru-RU')}.
        </p>
      )}
      {license?.tokens_left_month === 0 && (
        <p className="mt-4 text-xs text-amber-300">{t('license.monthLimit')}</p>
      )}
    </div>
  );
}
