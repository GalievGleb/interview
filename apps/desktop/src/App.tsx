import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import Layout from './components/Layout';
import { markMilestone } from './lib/activation';

// Route-level code splitting — keeps the initial bundle small and cold start fast.
const OnboardingPage = lazy(() => import('./pages/OnboardingPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const PreparePage = lazy(() => import('./pages/PreparePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const DocumentsPage = lazy(() => import('./pages/DocumentsPage'));
const DemoPage = lazy(() => import('./pages/DemoPage'));
const MeetingPage = lazy(() => import('./pages/MeetingPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
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
  const { onboardingDone, loading } = useApp();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-ink-muted">
        Загрузка...
      </div>
    );
  }
  if (!onboardingDone) {
    return <Navigate to="/onboarding" replace />;
  }
  return <Layout>{children}</Layout>;
}

/** Lets the main window respond to navigation requested from the overlay. */
function NavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => window.electronAPI?.onNavigate?.((path) => navigate(path)), [navigate]);

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
      void import('./pages/HistoryPage');
      void import('./pages/DocumentsPage');
      void import('./pages/SettingsPage');
      void import('./pages/MeetingPage');
      void import('./pages/TestLabPage');
      void import('./pages/BenchmarkPage');
      void import('./pages/DiagnosticsPage');
    };
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(prefetch);
      return () => window.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(prefetch, 1500);
    return () => window.clearTimeout(t);
  }, []);

  return null;
}

export default function App() {
  return (
    <AppProvider>
      <NavigationBridge />
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/overlay" element={<OverlayPage />} />
          <Route path="/home" element={<Gate><HomePage /></Gate>} />
          <Route path="/prepare" element={<Gate><PreparePage /></Gate>} />
          <Route path="/demo" element={<Gate><DemoPage /></Gate>} />
          <Route path="/meeting" element={<Gate><MeetingPage /></Gate>} />
          <Route path="/documents" element={<Gate><DocumentsPage /></Gate>} />
          <Route path="/history" element={<Gate><HistoryPage /></Gate>} />
          <Route path="/settings" element={<Gate><SettingsPage /></Gate>} />
          <Route path="/licenses" element={<Gate><LicensesPage /></Gate>} />
          <Route path="/test-lab" element={<Gate><TestLabPage /></Gate>} />
          <Route path="/benchmark" element={<Gate><BenchmarkPage /></Gate>} />
          <Route path="/diagnostics" element={<Gate><DiagnosticsPage /></Gate>} />
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </AppProvider>
  );
}
