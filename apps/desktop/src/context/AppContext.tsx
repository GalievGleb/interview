import { createContext, useContext, useEffect, useState, ReactNode, useCallback, useRef } from 'react';
import { api, KeysStatus } from '../lib/api';
import { refreshSessionKnowledge } from '../lib/sessionKnowledge';
import { syncMockSessionsFromBackend } from '../lib/vacancyReview/vacancyReviewStore';
import type { BackendStatus } from '../types/electron';
import { liveStartupWarmup } from '../lib/liveStartupWarmup';

export type LicenseInfo = import('../lib/api').LicenseStatusDto;

interface AppContextValue {
  keys: KeysStatus | null;
  loading: boolean;
  backendOnline: boolean;
  /** Живой статус процесса бэкенда из main: рестарт после падения / сдался. */
  backendStatus: BackendStatus | null;
  hasAnyKey: boolean;
  hasStt: boolean;
  /** null пока не загрузили; expired → live-режим мягко блокируется. */
  license: LicenseInfo | null;
  refreshKeys: () => Promise<void>;
  refreshLicense: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [keys, setKeys] = useState<KeysStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [backendOnline, setBackendOnline] = useState(false);
  const [sttReady, setSttReady] = useState(false);
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const knowledgeRefreshStartedRef = useRef(false);

  const refreshLicense = useCallback(async () => {
    try {
      setLicense(await api.licenseStatus());
    } catch {
      /* backend offline — не блокируем работу без данных о лицензии */
    }
  }, []);

  const refreshKeys = useCallback(async () => {
    try {
      await api.health();
      setBackendOnline(true);
      void liveStartupWarmup.warm();
      if (!knowledgeRefreshStartedRef.current) {
        knowledgeRefreshStartedRef.current = true;
        void refreshSessionKnowledge().catch(() => {
          knowledgeRefreshStartedRef.current = false;
        });
      }
      // Backend is up — reconcile mock-interview sessions into durable SQLite.
      void syncMockSessionsFromBackend();
      const k = await api.getKeys();
      setKeys(k);
    } catch {
      setBackendOnline(false);
      setKeys(null);
    }
    try {
      const diag = await api.sttProviders();
      const active = diag.providers.find((p) => p.id === diag.default);
      setSttReady(Boolean(active?.available));
    } catch {
      setSttReady(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refreshKeys();
      await refreshLicense();
      setLoading(false);
    })();
    const interval = setInterval(() => void refreshKeys(), 10000);
    // Лицензия меняется редко — проверяем раз в 10 минут.
    const licInterval = setInterval(() => void refreshLicense(), 600000);
    return () => {
      clearInterval(interval);
      clearInterval(licInterval);
    };
  }, [refreshKeys, refreshLicense]);

  useEffect(() => window.electronAPI?.account?.onState?.(() => {
    void refreshLicense();
    void refreshKeys();
  }), [refreshLicense, refreshKeys]);

  // Падение/перезапуск бэкенда main сообщает мгновенно — не ждём 10-сек поллинг.
  useEffect(() => {
    const unsub = window.electronAPI?.onBackendStatus?.((status) => {
      setBackendStatus(status);
      if (status.state === 'ok') void refreshKeys();
    });
    return () => unsub?.();
  }, [refreshKeys]);

  const hasAnyKey = !!keys && (keys.openai || keys.openrouter);
  const hasStt = sttReady;

  return (
    <AppContext.Provider
      value={{
        keys,
        loading,
        backendOnline,
        backendStatus,
        hasAnyKey,
        hasStt,
        license,
        refreshKeys,
        refreshLicense,
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
