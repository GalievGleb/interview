import { useEffect, useState } from 'react';
import { accountApi } from '../lib/accountApi';
import { useI18n } from '../lib/i18n';
import type { AccountDevice, AccountState } from '../types/electron';

type EmailMode = 'closed' | 'register' | 'login' | 'verify' | 'reset-request' | 'reset-confirm';

const loadingState: AccountState = {
  available: true, authenticated: false, user: null, subscription: null, error: null,
};

export default function AccountCard() {
  const { t, lang } = useI18n();
  const [account, setAccount] = useState<AccountState>(loadingState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<EmailMode>('closed');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<AccountDevice[]>([]);

  useEffect(() => {
    let active = true;
    void accountApi.getState().then((state) => {
      if (!active) return;
      setAccount(state);
      setLoading(false);
    });
    const unsubscribe = accountApi.onState((state) => {
      if (!active) return;
      setAccount(state);
      setLoading(false);
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!account.authenticated) {
      setDevices([]);
      return;
    }
    void accountApi.listDevices().then(setDevices).catch(() => setDevices([]));
  }, [account.authenticated]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (caught) {
      const value = caught instanceof Error ? caught.message : '';
      setError(value.includes('DEVICE_LIMIT_REACHED') ? t('account.deviceLimit') : t('account.error'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="sc-card mb-5 p-5 text-sm text-ink-muted">{t('account.loading')}</div>;
  }
  if (!account.available) {
    return (
      <div className="sc-card mb-5 p-5">
        <h3 className="text-sm font-semibold text-ink">{t('account.title')}</h3>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t('account.unavailable')}</p>
      </div>
    );
  }

  if (account.authenticated && account.user) {
    const plan = account.subscription?.status === 'ACTIVE' ? account.subscription.plan : null;
    return (
      <div className="sc-card mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {account.user.avatarUrl ? (
              <img src={account.user.avatarUrl} alt="" className="h-11 w-11 rounded-full" referrerPolicy="no-referrer" />
            ) : (
              <div className="grid h-11 w-11 place-items-center rounded-full bg-accent-soft text-sm font-bold text-accent">
                {(account.user.displayName || account.user.email).slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-ink">{account.user.displayName || t('account.title')}</h3>
              <p className="truncate text-xs text-ink-muted">{account.user.email}</p>
            </div>
          </div>
          <button type="button" className="btn-secondary btn-sm" onClick={() => void run(async () => setAccount(await accountApi.logout()))}>
            {t('account.logout')}
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-surface-border bg-surface-light/60 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{t('account.plan')}</p>
          <p className="mt-1 text-sm font-semibold text-ink">
            {plan ? (plan === 'PRO' ? 'SkillCue Максимум' : 'SkillCue Базовый') : t('account.noPlan')}
          </p>
          {account.subscription?.currentPeriodEnd && plan && (
            <p className="mt-1 text-xs text-ink-faint">
              {new Date(account.subscription.currentPeriodEnd).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US')}
            </p>
          )}
        </div>

        <div className="mt-4">
          <h4 className="text-sm font-semibold text-ink">{t('account.devices')}</h4>
          <p className="mt-0.5 text-xs text-ink-faint">{t('account.devicesHint')}</p>
          <div className="mt-2 space-y-2">
            {devices.map((device) => (
              <div key={device.id} className="flex items-center justify-between gap-3 rounded-xl border border-surface-border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-ink">
                    {device.name}{device.current ? ` · ${t('account.currentDevice')}` : ''}
                  </p>
                  <p className="text-[11px] text-ink-faint">
                    {new Date(device.lastSeenAt).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US')}
                  </p>
                </div>
                {!device.current && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => void run(async () => {
                      await accountApi.revokeDevice(device.id);
                      setDevices(await accountApi.listDevices());
                    })}
                  >
                    {t('account.revoke')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-red-400" role="alert">{error}</p>}
      </div>
    );
  }

  const submitEmail = () => run(async () => {
    if (mode === 'register') {
      const result = await accountApi.register(email, password);
      setEmail(result.email);
      setMode('verify');
      setMessage(t('account.codeSent'));
      return;
    }
    if (mode === 'login') {
      setAccount(await accountApi.login(email, password));
      return;
    }
    if (mode === 'verify') {
      setAccount(await accountApi.verifyEmail(email, code));
      return;
    }
    if (mode === 'reset-request') {
      await accountApi.requestPasswordReset(email);
      setMode('reset-confirm');
      setMessage(t('account.codeSent'));
      return;
    }
    if (mode === 'reset-confirm') {
      await accountApi.confirmPasswordReset(email, code, password);
      setMode('login');
      setCode('');
      setMessage(t('account.resetDone'));
    }
  });

  return (
    <div className="sc-card mb-5 p-5">
      <h3 className="text-sm font-semibold text-ink">{t('account.title')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t('account.subtitle')}</p>
      <button
        type="button"
        className="btn-primary mt-4 w-full"
        disabled={busy}
        onClick={() => void run(async () => setAccount(await accountApi.googleLogin()))}
      >
        <span className="mr-2 inline-grid h-5 w-5 place-items-center rounded bg-white font-bold text-blue-600">G</span>
        {t('account.google')}
      </button>

      {mode === 'closed' ? (
        <button type="button" className="btn-secondary mt-2 w-full" onClick={() => setMode('register')}>
          {t('account.emailFallback')}
        </button>
      ) : (
        <form className="mt-4 space-y-3 border-t border-surface-border pt-4" onSubmit={(event) => { event.preventDefault(); void submitEmail(); }}>
          <label className="block text-xs font-semibold text-ink-muted">
            {t('account.email')}
            <input aria-label={t('account.email')} type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="field mt-1 w-full" />
          </label>
          {(mode === 'register' || mode === 'login' || mode === 'reset-confirm') && (
            <label className="block text-xs font-semibold text-ink-muted">
              {t('account.password')}
              <input aria-label={t('account.password')} type="password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} className="field mt-1 w-full" />
            </label>
          )}
          {(mode === 'verify' || mode === 'reset-confirm') && (
            <label className="block text-xs font-semibold text-ink-muted">
              {t('account.code')}
              <input aria-label={t('account.code')} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/gu, ''))} className="field mt-1 w-full font-mono" />
            </label>
          )}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {mode === 'register' ? t('account.create') : mode === 'login' ? t('account.login') : mode === 'verify' ? t('account.verify') : mode === 'reset-request' ? t('account.resetRequest') : t('account.resetConfirm')}
          </button>
          <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs">
            {mode === 'register' && <button type="button" className="text-accent" onClick={() => setMode('login')}>{t('account.haveAccount')}</button>}
            {mode === 'login' && <button type="button" className="text-accent" onClick={() => setMode('register')}>{t('account.needAccount')}</button>}
            {mode === 'login' && <button type="button" className="text-accent" onClick={() => setMode('reset-request')}>{t('account.forgot')}</button>}
            {mode === 'verify' && <button type="button" className="text-accent" onClick={() => void run(async () => { await accountApi.requestVerification(email); setMessage(t('account.codeSent')); })}>{t('account.resend')}</button>}
          </div>
        </form>
      )}
      {message && <p className="mt-3 text-xs text-emerald-400" role="status">{message}</p>}
      {error && <p className="mt-3 text-xs text-red-400" role="alert">{error}</p>}
    </div>
  );
}
