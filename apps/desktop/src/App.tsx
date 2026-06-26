import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import Layout from './components/Layout';
import OnboardingPage from './pages/OnboardingPage';
import SettingsPage from './pages/SettingsPage';
import DocumentsPage from './pages/DocumentsPage';
import InterviewPage from './pages/InterviewPage';
import MeetingPage from './pages/MeetingPage';
import HistoryPage from './pages/HistoryPage';
import TestLabPage from './pages/TestLabPage';
import BenchmarkPage from './pages/BenchmarkPage';
import DiagnosticsPage from './pages/DiagnosticsPage';
import LicensesPage from './pages/LicensesPage';
import OverlayPage from './pages/OverlayPage';

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
  return null;
}

export default function App() {
  return (
    <AppProvider>
      <NavigationBridge />
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/overlay" element={<OverlayPage />} />
        <Route path="/interview" element={<Gate><InterviewPage /></Gate>} />
        <Route path="/meeting" element={<Gate><MeetingPage /></Gate>} />
        <Route path="/documents" element={<Gate><DocumentsPage /></Gate>} />
        <Route path="/history" element={<Gate><HistoryPage /></Gate>} />
        <Route path="/settings" element={<Gate><SettingsPage /></Gate>} />
        <Route path="/licenses" element={<Gate><LicensesPage /></Gate>} />
        <Route path="/test-lab" element={<Gate><TestLabPage /></Gate>} />
        <Route path="/benchmark" element={<Gate><BenchmarkPage /></Gate>} />
        <Route path="/diagnostics" element={<Gate><DiagnosticsPage /></Gate>} />
        <Route path="/" element={<Navigate to="/interview" replace />} />
        <Route path="*" element={<Navigate to="/interview" replace />} />
      </Routes>
    </AppProvider>
  );
}
