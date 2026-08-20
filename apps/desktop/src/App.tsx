import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import Layout from './components/Layout';
import { markMilestone } from './lib/activation';
import { api } from './lib/api';
import {
  liveReadinessDelayMs,
  shouldNotifyReadinessFailure,
  type ReadinessFailureNotice,
} from './lib/liveReadinessMonitor';

// Route-level code splitting — keeps the initial bundle small and cold start fast.
const DEV_SURFACE = import.meta.env.MODE === 'devbuild';
const HomePage = lazy(() => import('./pages/HomePage'));
const PreparePage = lazy(() => import('./pages/PreparePage'));
const PracticePage = lazy(() => import('./pages/PracticePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const DocumentsPage = lazy(() => import('./pages/DocumentsPage'));
const DemoPage = lazy(() => import('./pages/DemoPage'));
const MeetingPage = DEV_SURFACE ? lazy(() => import('./pages/MeetingPage')) : null;
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const SessionAnalysisPage = lazy(() => import('./pages/SessionAnalysisPage'));
const HhApplicationsPage = lazy(() => import('./pages/HhApplicationsPage'));
const HhHrProfilePage = lazy(() => import('./pages/HhHrProfilePage'));
const InterviewCalendarPage = lazy(() => import('./pages/InterviewCalendarPage'));
const TestLabPage = DEV_SURFACE ? lazy(() => import('./pages/TestLabPage')) : null;
const BenchmarkPage = DEV_SURFACE ? lazy(() => import('./pages/BenchmarkPage')) : null;
const DiagnosticsPage = DEV_SURFACE ? lazy(() => import('./pages/DiagnosticsPage')) : null;
const LicensesPage = DEV_SURFACE ? lazy(() => import('./pages/LicensesPage')) : null;
const OverlayPage = lazy(() => import('./pages/OverlayPage'));

function PageFallback() {
  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center text-sm text-ink-muted">
      Загрузка…
    </div>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { loading } = useApp();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-ink-muted">
        Загрузка...
      </div>
    );
  }
  return <Layout>{children}</Layout>;
}

function LegacyProgressRedirect() {
  const { search } = useLocation();
  const start = new URLSearchParams(search).get('start');
  if (start === 'goal' || start === 'assessment') {
    return <Navigate to={`/documents?mode=baseline&section=${start === 'goal' ? 'goal' : 'baseline'}`} replace />;
  }
  return <Navigate to="/practice" replace />;
}

/** Lets the main window respond to navigation requested from the overlay. */
function NavigationBridge() {
  const navigate = useNavigate();
  const location = useLocation();
  const isOverlayWindow = location.pathname === '/overlay';
  useEffect(() => window.electronAPI?.onNavigate?.((path) => navigate(path)), [navigate]);

  // Ключ из ссылки skillcue://activate?key=… (после оплаты на сайте) → раскрываем
  // Настройки → Тарифы и передаём ключ карточке лицензии, которая активирует его
  // и показывает результат (успех/ошибка) своим же UI, в любом статусе.
  useEffect(
    () =>
      window.electronAPI?.onActivateLicense?.((key) => {
        navigate('/settings?tab=billing', { state: { activateKey: key } });
      }),
    [navigate],
  );

  // Live-сессия крутится в окне оверлея (отдельный процесс) — его window-события
  // сюда не долетают. Main-процесс пробрасывает состояние, а мы ре-диспатчим те
  // же события в главном окне, чтобы TitleBar-хронометр и веха активации работали.
  useEffect(
    () =>
      window.electronAPI?.onLiveState?.((active) => {
        window.dispatchEvent(new Event(active ? 'skillcue:live-start' : 'skillcue:live-stop'));
      }),
    [],
  );

  // Вехи активации: установка (первый запуск) и старт первой live-сессии.
  useEffect(() => {
    markMilestone('firstRun');
    const onLive = () => markMilestone('liveStarted');
    window.addEventListener('skillcue:live-start', onLive);
    return () => window.removeEventListener('skillcue:live-start', onLive);
  }, []);

  // Warm the lazy route chunks once the app is idle so navigation feels instant
  // (keeps the small initial bundle, but no load flash on first visit to a route).
  useEffect(() => {
    const prefetch = () => {
      void import('./pages/HomePage');
      void import('./pages/PreparePage');
      void import('./pages/PracticePage');
      void import('./pages/HistoryPage');
      void import('./pages/SessionAnalysisPage');
      void import('./pages/HhApplicationsPage');
      void import('./pages/HhHrProfilePage');
      void import('./pages/InterviewCalendarPage');
      void import('./pages/DocumentsPage');
      void import('./pages/SettingsPage');
      if (DEV_SURFACE) {
        void import('./pages/MeetingPage');
        void import('./pages/TestLabPage');
        void import('./pages/BenchmarkPage');
        void import('./pages/DiagnosticsPage');
        void import('./pages/LicensesPage');
      }
    };
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(prefetch);
      return () => window.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(prefetch, 1500);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (isOverlayWindow) return;
    const storageKey = 'skillcue.liveReadiness.lastFailure';
    let active = true;
    let startupTimer: number | undefined;
    let interviewTimer: number | undefined;
    let unsubscribe: (() => void) | undefined;

    const check = async () => {
      try {
        const readiness = await api.providerReadiness();
        if (readiness.ok) localStorage.removeItem(storageKey);
      } catch {
        const now = new Date();
        let previous: ReadinessFailureNotice | null = null;
        try { previous = JSON.parse(localStorage.getItem(storageKey) || 'null') as ReadinessFailureNotice | null; } catch { /* ignore corrupt local state */ }
        if (!active || !shouldNotifyReadinessFailure(previous, 'provider_unavailable', now)) return;
        const next = { code: 'provider_unavailable', notifiedAt: now.toISOString() };
        localStorage.setItem(storageKey, JSON.stringify(next));
        await window.electronAPI?.notifyReadinessFailure?.('provider_unavailable');
      }
    };
    const scheduleForEvents = (events: import('./types/electron').InterviewCalendarEvent[]) => {
      if (interviewTimer != null) window.clearTimeout(interviewTimer);
      const delay = liveReadinessDelayMs(events);
      if (delay == null) return;
      interviewTimer = window.setTimeout(() => void check(), Math.min(delay, 2_147_000_000));
    };

    startupTimer = window.setTimeout(() => void check(), 5_000);
    const calendar = window.electronAPI?.interviewCalendar;
    void calendar?.getState().then((state) => { if (active) scheduleForEvents(state.events); }).catch(() => {});
    unsubscribe = calendar?.onState((state) => scheduleForEvents(state.events));
    return () => {
      active = false;
      if (startupTimer != null) window.clearTimeout(startupTimer);
      if (interviewTimer != null) window.clearTimeout(interviewTimer);
      unsubscribe?.();
    };
  }, [isOverlayWindow]);

  return null;
}

export default function App() {
  return (
    <AppProvider>
      <NavigationBridge />
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/overlay" element={<OverlayPage />} />
          <Route path="/home" element={<Gate><HomePage /></Gate>} />
          <Route path="/prepare" element={<Gate><PreparePage /></Gate>} />
          <Route path="/practice" element={<Gate><PracticePage /></Gate>} />
          <Route path="/practice/new" element={<Gate><PreparePage /></Gate>} />
          <Route path="/practice/session" element={<Gate><PreparePage /></Gate>} />
          <Route path="/demo" element={<Gate><DemoPage /></Gate>} />
          {DEV_SURFACE && MeetingPage && <Route path="/meeting" element={<Gate><MeetingPage /></Gate>} />}
          <Route path="/documents" element={<Gate><DocumentsPage /></Gate>} />
          <Route path="/history" element={<Gate><HistoryPage /></Gate>} />
          <Route path="/history/:sessionId" element={<Gate><SessionAnalysisPage /></Gate>} />
          <Route path="/progress" element={<LegacyProgressRedirect />} />
          <Route path="/applications" element={<Gate><HhApplicationsPage /></Gate>} />
          <Route path="/applications/hr-profile" element={<Gate><HhHrProfilePage /></Gate>} />
          <Route path="/calendar" element={<Gate><InterviewCalendarPage /></Gate>} />
          <Route path="/settings" element={<Gate><SettingsPage /></Gate>} />
          {DEV_SURFACE && LicensesPage && <Route path="/licenses" element={<Gate><LicensesPage /></Gate>} />}
          {DEV_SURFACE && TestLabPage && <Route path="/test-lab" element={<Gate><TestLabPage /></Gate>} />}
          {DEV_SURFACE && BenchmarkPage && <Route path="/benchmark" element={<Gate><BenchmarkPage /></Gate>} />}
          {DEV_SURFACE && DiagnosticsPage && <Route path="/diagnostics" element={<Gate><DiagnosticsPage /></Gate>} />}
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </AppProvider>
  );
}
