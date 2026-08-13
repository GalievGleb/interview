import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import Layout from './components/Layout';
import { markMilestone } from './lib/activation';
import { useBuildChannel } from './lib/buildChannel';

// Route-level code splitting — keeps the initial bundle small and cold start fast.
const HomePage = lazy(() => import('./pages/HomePage'));
const PreparePage = lazy(() => import('./pages/PreparePage'));
const PracticePage = lazy(() => import('./pages/PracticePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const DocumentsPage = lazy(() => import('./pages/DocumentsPage'));
const DemoPage = lazy(() => import('./pages/DemoPage'));
const MeetingPage = lazy(() => import('./pages/MeetingPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const SessionAnalysisPage = lazy(() => import('./pages/SessionAnalysisPage'));
const HhApplicationsPage = lazy(() => import('./pages/HhApplicationsPage'));
const HhHrProfilePage = lazy(() => import('./pages/HhHrProfilePage'));
const InterviewCalendarPage = lazy(() => import('./pages/InterviewCalendarPage'));
const TestLabPage = lazy(() => import('./pages/TestLabPage'));
const BenchmarkPage = lazy(() => import('./pages/BenchmarkPage'));
const DiagnosticsPage = lazy(() => import('./pages/DiagnosticsPage'));
const LicensesPage = lazy(() => import('./pages/LicensesPage'));
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

function DeveloperGate({ children }: { children: React.ReactNode }) {
  const channel = useBuildChannel();
  if (channel == null) return <PageFallback />;
  if (channel !== 'dev') return <Navigate to="/home" replace />;
  return <Gate>{children}</Gate>;
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
  const buildChannel = useBuildChannel();
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
      if (buildChannel === 'dev') {
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
  }, [buildChannel]);

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
          <Route path="/meeting" element={<DeveloperGate><MeetingPage /></DeveloperGate>} />
          <Route path="/documents" element={<Gate><DocumentsPage /></Gate>} />
          <Route path="/history" element={<Gate><HistoryPage /></Gate>} />
          <Route path="/history/:sessionId" element={<Gate><SessionAnalysisPage /></Gate>} />
          <Route path="/progress" element={<LegacyProgressRedirect />} />
          <Route path="/applications" element={<Gate><HhApplicationsPage /></Gate>} />
          <Route path="/applications/hr-profile" element={<Gate><HhHrProfilePage /></Gate>} />
          <Route path="/calendar" element={<Gate><InterviewCalendarPage /></Gate>} />
          <Route path="/settings" element={<Gate><SettingsPage /></Gate>} />
          <Route path="/licenses" element={<DeveloperGate><LicensesPage /></DeveloperGate>} />
          <Route path="/test-lab" element={<DeveloperGate><TestLabPage /></DeveloperGate>} />
          <Route path="/benchmark" element={<DeveloperGate><BenchmarkPage /></DeveloperGate>} />
          <Route path="/diagnostics" element={<DeveloperGate><DiagnosticsPage /></DeveloperGate>} />
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </AppProvider>
  );
}
