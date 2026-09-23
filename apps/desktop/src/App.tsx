import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import StartupGate from './components/StartupGate';
import { markMilestone } from './lib/activation';
import { api } from './lib/api';
import {
  liveReadinessDelayMs,
  shouldNotifyReadinessFailure,
  type ReadinessFailureNotice,
} from './lib/liveReadinessMonitor';

// Route-level code splitting — keeps the initial bundle small and cold start fast.
const DEV_SURFACE = ['devbuild', 'alphabuild'].includes(import.meta.env.MODE);
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

  // Warm route chunks immediately after the first paint. requestIdleCallback can
  // be delayed for seconds on a busy M1 while the local backend starts.
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
    let timer: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(prefetch, 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (isOverlayWindow) return;
    const storageKey = 'skillcue.liveReadiness.lastFailure';
    let active = true;
    let interviewTimer: number | undefined;

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

    const startupTimer = window.setTimeout(() => void check(), 5_000);
    const calendar = window.electronAPI?.interviewCalendar;
    void calendar?.getState().then((state) => { if (active) scheduleForEvents(state.events); }).catch(() => {});
    const unsubscribe = calendar?.onState((state) => scheduleForEvents(state.events));
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
          <Route path="/home" element={<StartupGate><HomePage /></StartupGate>} />
          <Route path="/prepare" element={<StartupGate><PreparePage /></StartupGate>} />
          <Route path="/practice" element={<StartupGate><PracticePage /></StartupGate>} />
          <Route path="/practice/new" element={<StartupGate><PreparePage /></StartupGate>} />
          <Route path="/practice/session" element={<StartupGate><PreparePage /></StartupGate>} />
          <Route path="/demo" element={<StartupGate><DemoPage /></StartupGate>} />
          {DEV_SURFACE && MeetingPage && <Route path="/meeting" element={<StartupGate><MeetingPage /></StartupGate>} />}
          <Route path="/documents" element={<StartupGate><DocumentsPage /></StartupGate>} />
          <Route path="/history" element={<StartupGate><HistoryPage /></StartupGate>} />
          <Route path="/history/:sessionId" element={<StartupGate><SessionAnalysisPage /></StartupGate>} />
          <Route path="/progress" element={<LegacyProgressRedirect />} />
          <Route path="/applications" element={<StartupGate><HhApplicationsPage /></StartupGate>} />
          <Route path="/applications/hr-profile" element={<StartupGate><HhHrProfilePage /></StartupGate>} />
          <Route path="/calendar" element={<StartupGate><InterviewCalendarPage /></StartupGate>} />
          <Route path="/settings" element={<StartupGate><SettingsPage /></StartupGate>} />
          {DEV_SURFACE && LicensesPage && <Route path="/licenses" element={<StartupGate><LicensesPage /></StartupGate>} />}
          {DEV_SURFACE && TestLabPage && <Route path="/test-lab" element={<StartupGate><TestLabPage /></StartupGate>} />}
          {DEV_SURFACE && BenchmarkPage && <Route path="/benchmark" element={<StartupGate><BenchmarkPage /></StartupGate>} />}
          {DEV_SURFACE && DiagnosticsPage && <Route path="/diagnostics" element={<StartupGate><DiagnosticsPage /></StartupGate>} />}
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </AppProvider>
  );
}
