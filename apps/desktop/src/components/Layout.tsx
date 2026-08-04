import { ReactNode, Suspense, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import CommandPalette from './CommandPalette';
import UpdateToast from './UpdateToast';
import { useApp } from '../context/AppContext';
import { useI18n, type I18nKey } from '../lib/i18n';
import { getBackendBannerKind } from './layout/backendBanner';

const WIDE_ROUTES = new Set(['/meeting']);
const PREP_ROUTES = new Set(['/home', '/prepare', '/documents', '/history']);
const NO_TITLEBAR_ROUTES = new Set(['/meeting']);
const ROUTE_TITLE_KEYS: Record<string, I18nKey> = {
  '/home': 'nav.home',
  '/prepare': 'nav.prepare',
  '/applications': 'nav.applications',
  '/documents': 'nav.documents',
  '/history': 'nav.history',
  '/settings': 'nav.settings',
  '/test-lab': 'cmd.testlab',
  '/benchmark': 'cmd.benchmark',
  '/diagnostics': 'cmd.diagnostics',
};

function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function TitleBar({ pathname }: { pathname: string }) {
  const { t } = useI18n();
  const [live, setLive] = useState(false);
  const [liveStart, setLiveStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onStart = () => {
      setLive(true);
      setLiveStart((previous) => previous ?? Date.now());
    };
    const onStop = () => {
      setLive(false);
      setLiveStart(null);
    };
    window.addEventListener('skillcue:live-start', onStart);
    window.addEventListener('skillcue:live-stop', onStop);
    return () => {
      window.removeEventListener('skillcue:live-start', onStart);
      window.removeEventListener('skillcue:live-stop', onStop);
    };
  }, []);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  return (
    <header className="skillcue-titlebar">
      <span className="text-[13px] font-medium text-ink-muted">
        {t(ROUTE_TITLE_KEYS[pathname] ?? 'nav.home')}
      </span>
      {live && (
        <div className="ml-auto flex items-center gap-2 text-[12px] text-ink-muted">
          <span className="sc-dot sc-dot--live" />
          <span>{t('shell.liveSession')}</span>
          {liveStart != null && <span className="sc-mono">{elapsed(now - liveStart)}</span>}
        </div>
      )}
    </header>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { backendOnline, backendStatus } = useApp();
  const { t } = useI18n();
  const { pathname } = useLocation();
  const wide = WIDE_ROUTES.has(pathname);
  const prep = PREP_ROUTES.has(pathname);
  const showTitleBar = !NO_TITLEBAR_ROUTES.has(pathname);
  const backendBannerKind = getBackendBannerKind({
    backendOnline,
    backendStatus,
    isDev: import.meta.env.DEV,
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-ink">
      <a href="#skillcue-main" className="skillcue-skip-link">
        {t('shell.skipContent')}
      </a>
      <CommandPalette />
      <UpdateToast />
      {showTitleBar && <TitleBar pathname={pathname} />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main
          id="skillcue-main"
          className="skillcue-main flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          {backendBannerKind === 'failed' ? (
            <div
              className="flex shrink-0 items-center gap-2 border-b border-red-900/40 bg-red-950/20 px-5 py-2 text-sm text-red-200/90"
              role="status"
            >
              <span className="sc-dot sc-dot--error" />
              {t('shell.backendFailed')}
            </div>
          ) : (
            backendBannerKind === 'dev-offline' && (
              <div
                className="flex shrink-0 items-center gap-2 border-b border-amber-900/30 bg-amber-950/20 px-5 py-2 text-sm text-amber-200/90"
                role="status"
              >
                <span className="sc-dot sc-dot--processing animate-pulse" />
                {t('shell.backendConnecting')}{' '}
                <code className="rounded-md bg-black/30 px-1.5 py-0.5 text-amber-100">
                  cd apps/api-py; .\run_dev.ps1
                </code>
              </div>
            )
          )}
          <div
            className={`mx-auto flex min-h-0 w-full flex-1 flex-col ${
              prep
                ? 'max-w-none overflow-hidden p-0'
                : wide
                  ? 'max-w-[1600px] px-5 py-4'
                  : 'max-w-[1280px] overflow-y-auto px-8 py-8'
            }`}
          >
            <Suspense
              fallback={
                <div className="flex min-h-[40vh] items-center justify-center text-sm text-ink-muted">
                  {t('shell.loading')}
                </div>
              }
            >
              {children}
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}
