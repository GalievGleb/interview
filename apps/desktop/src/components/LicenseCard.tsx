import { useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';

const PLAN_LABELS: Record<string, string> = {
  trial: 'Пробный доступ',
  basic: 'Basic — подготовка',
  max: 'Max — всё включено',
};

/** Лицензия: 15-мин live-trial, тариф, месячный токен-бюджет + активация ключа. */
export default function LicenseCard() {
  const { license, refreshLicense } = useApp();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  if (!license) return null;

  const activate = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await api.activateLicense(key.trim());
      setMessage(`Лицензия активирована (${PLAN_LABELS[res.plan] ?? res.plan})`);
      setKey('');
      await refreshLicense();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось активировать ключ');
    } finally {
      setBusy(false);
    }
  };

  const minutesLeft =
    license.live_seconds_left != null ? Math.ceil(license.live_seconds_left / 60) : null;

  const badge =
    license.status === 'active' ? (
      <span className="sc-badge sc-badge--success">
        <span className="sc-dot sc-dot--success" /> {PLAN_LABELS[license.plan] ?? license.plan}
      </span>
    ) : license.status === 'trial' ? (
      <span className="sc-badge sc-badge--accent">Trial · осталось {minutesLeft} мин live</span>
    ) : (
      <span className="sc-badge sc-badge--error">Пробные минуты закончились</span>
    );

  const quotaPct = Math.min(
    100,
    Math.round((license.tokens_used_month / Math.max(1, license.tokens_budget_month)) * 100),
  );

  return (
    <div className="sc-card mb-5 p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">Лицензия</h3>
        {badge}
      </div>

      {license.status === 'active' ? (
        <p className="text-sm text-ink-muted">
          Оформлена на <span className="text-ink">{license.licensed_to}</span>.
          {license.plan === 'basic' &&
            ' Live-режим и оверлей доступны на тарифе max — напишите нам для апгрейда.'}
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-muted">
            {license.status === 'trial'
              ? 'Попробуйте live-режим: 15 минут бесплатно, плюс небольшой лимит на подготовку. Дальше — по лицензии.'
              : 'Пробные live-минуты израсходованы: live приостановлен, подготовка работает в рамках лимита. Введите ключ, чтобы продолжить.'}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="SKILLCUE-…"
              className="field flex-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => void activate()}
              disabled={busy || !key.trim()}
              className="btn-primary btn-sm shrink-0"
            >
              {busy ? 'Проверяю…' : 'Активировать'}
            </button>
          </div>
          {message && <p className="mt-2 text-xs text-emerald-400">{message}</p>}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </>
      )}

      {/* Месячный токен-бюджет тарифа — серверный лимит, защищает стоимость API. */}
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between text-[11px] text-ink-faint">
          <span>Токены за месяц</span>
          <span className="sc-mono">
            {license.tokens_used_month.toLocaleString('ru')} /{' '}
            {license.tokens_budget_month.toLocaleString('ru')}
          </span>
        </div>
        <span className="sc-progress">
          <span
            className="sc-progress__fill"
            style={{
              width: `${quotaPct}%`,
              backgroundColor: quotaPct >= 90 ? '#f87171' : quotaPct >= 70 ? '#fbbf24' : undefined,
            }}
          />
        </span>
        {license.tokens_left_month === 0 && (
          <p className="mt-1.5 text-xs text-amber-300">
            Лимит исчерпан — AI-функции приостановлены до 1-го числа.
          </p>
        )}
      </div>
    </div>
  );
}
