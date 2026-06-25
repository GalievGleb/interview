import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { api, KeysStatus } from '../lib/api';

interface AppContextValue {
  keys: KeysStatus | null;
  loading: boolean;
  backendOnline: boolean;
  hasAnyKey: boolean;
  hasStt: boolean;
  onboardingDone: boolean;
  completeOnboarding: () => void;
  refreshKeys: () => Promise<void>;
}

const ONBOARDING_KEY = 'copilot-onboarding-done';

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<KeysStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [backendOnline, setBackendOnline] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState(
    () => localStorage.getItem(ONBOARDING_KEY) === '1',
  );

  const [sttReady, setSttReady] = useState(false);

  const refreshKeys = useCallback(async () => {
    try {
      await api.health();
      setBackendOnline(true);
      const k = await api.getKeys();
      setKeys(k);
    } catch {
      setBackendOnline(false);
      setKeys(null);
    }
    // Local STT readiness: the configured Whisper model must be downloaded.
    try {
      const diag = await api.sttProviders();
      const whisper = diag.providers.find((p) => p.id === 'whisper-local');
      setSttReady(!!whisper && whisper.available && whisper.reason === 'ready');
    } catch {
      setSttReady(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshKeys();
      setLoading(false);
    })();
    const interval = setInterval(() => void refreshKeys(), 10000);
    return () => clearInterval(interval);
  }, [refreshKeys]);

  const completeOnboarding = () => {
    localStorage.setItem(ONBOARDING_KEY, '1');
    setOnboardingDone(true);
  };

  const hasAnyKey = !!keys && (keys.openai || keys.openrouter);
  const hasStt = sttReady;

  return (
    <AppContext.Provider
      value={{
        keys,
        loading,
        backendOnline,
        hasAnyKey,
        hasStt,
        onboardingDone,
        completeOnboarding,
        refreshKeys,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
