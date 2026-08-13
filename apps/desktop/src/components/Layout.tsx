import { ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import CommandPalette from './CommandPalette';
import UpdateToast from './UpdateToast';
import { useApp } from '../context/AppContext';
import { useI18n, type I18nKey } from '../lib/i18n';
import { getBackendBannerKind } from './layout/backendBanner';
import { formatLiveElapsed } from '../lib/liveElapsed';

const WIDE_ROUTES = new Set(['/meeting']);
const PREP_ROUTES = new Set(['/home', '/prepare', '/documents', '/practice', '/history']);
const NO_TITLEBAR_ROUTES = new Set(['/meeting']);
const ROUTE_TITLE_KEYS: Record<string, I18nKey> = {
  '/home': 'nav.home',
  '/prepare': 'nav.prepare',
  '/applications': 'nav.applications',
  '/applications/hr-profile': 'nav.applications',
  '/calendar': 'nav.calendar',
  '/documents': 'nav.documents',
  '/practice': 'nav.practice',
  '/history': 'nav.history',
  '/settings': 'nav.settings',
  '/test-lab': 'cmd.testlab',
  '/benchmark': 'cmd.benchmark',
  '/diagnostics': 'cmd.diagnostics',
};

function TitleBar({ pathname }: { pathname: string }) {
  const { t } = useI18n();
  const [live, setLive] = useState(false);
  const [liveStart, setLiveStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onStart = () => {
      const startedAt = Date.now();
      setLive(true);
      setLiveStart((previous) => previous ?? startedAt);
      // `now` may still contain the time at which the main window mounted.
      // Refresh it in the same event so the first live frame cannot go negative.
      setNow(startedAt);
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
    setNow(Date.now());
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
          {liveStart != null && (
            <span className="sc-mono">{formatLiveElapsed(now - liveStart)}</span>
          )}
        </div>
      )}
    </header>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { backendOnline, backendStatus } = useApp();
  const { t } = useI18n();
  const { pathname } = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const routeKey = pathname.startsWith('/history/')
    ? '/history'
    : pathname.startsWith('/practice/')
      ? '/practice'
      : pathname;
  const wide = WIDE_ROUTES.has(routeKey);
  const prep = PREP_ROUTES.has(routeKey);
  const showTitleBar = !NO_TITLEBAR_ROUTES.has(routeKey);
  const backendBannerKind = getBackendBannerKind({
    backendOnline,
    backendStatus,
    isDev: import.meta.env.DEV,
  });

  useEffect(() => {
    // Контент прокручивается внутри оболочки приложения. Без явного сброса новый
    // раздел наследует позицию предыдущего и может открыться сразу с середины.
    contentRef.current?.scrollTo({ top: 0, left: 0 });
    document.title = `${t(ROUTE_TITLE_KEYS[routeKey] ?? 'nav.home')} · SkillCue`;
    window.requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
  }, [pathname, routeKey, t]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-ink">
      <a href="#skillcue-main" className="skillcue-skip-link">
        {t('shell.skipContent')}
      </a>
      <CommandPalette />
      <UpdateToast />
      {showTitleBar && <TitleBar pathname={routeKey} />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main
          ref={mainRef}
          id="skillcue-main"
          tabIndex={-1}
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
                className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-900/30 bg-amber-950/20 px-3 py-2 text-sm text-amber-200/90 sm:px-5"
                role="status"
              >
                <span className="sc-dot sc-dot--processing motion-safe:animate-pulse" />
                {t('shell.backendConnecting')}{' '}
                <code className="min-w-0 break-all rounded-md bg-black/30 px-1.5 py-0.5 text-amber-100">
                  cd apps/api-py; .\run_dev.ps1
                </code>
              </div>
            )
          )}
          <div
            key={pathname}
            ref={contentRef}
            className={`mx-auto flex min-h-0 w-full flex-1 flex-col ${
              prep
                ? 'max-w-none overflow-hidden p-0'
                : wide
                  ? 'max-w-[1600px] px-5 py-4'
                  : 'max-w-[1280px] overflow-y-auto px-4 py-4 sm:px-8 sm:py-8'
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
