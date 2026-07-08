import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { api, KeysStatus, type SttEngineId } from '../lib/api';
import { syncMockSessionsFromBackend } from '../lib/vacancyReview/vacancyReviewStore';
import type { BackendStatus } from '../types/electron';

export type LicenseInfo = import('../lib/api').LicenseStatusDto;

interface AppContextValue {
  keys: KeysStatus | null;
  loading: boolean;
  backendOnline: boolean;
  /** Живой статус процесса бэкенда из main: рестарт после падения / сдался. */
  backendStatus: BackendStatus | null;
  hasAnyKey: boolean;
  hasStt: boolean;
  /** Активный движок распознавания — определяет, уходит ли аудио в облако. */
  sttEngine: SttEngineId;
  onboardingDone: boolean;
  /** null пока не загрузили; expired → live-режим мягко блокируется. */
  license: LicenseInfo | null;
  completeOnboarding: () => void;
  refreshKeys: () => Promise<void>;
  refreshLicense: () => Promise<void>;
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
  const [sttEngine, setSttEngine] = useState<SttEngineId>('whisper');
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);

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
      // Backend is up — reconcile mock-interview sessions into durable SQLite.
      void syncMockSessionsFromBackend();
      const k = await api.getKeys();
      setKeys(k);
    } catch {
      setBackendOnline(false);
      setKeys(null);
    }
    // STT readiness must reflect the ACTIVE engine, not always Whisper. If the
    // user picked a cloud engine (Yandex SpeechKit / Deepgram), «готовность» =
    // тот провайдер доступен (ключ или гейтвей), а не «скачан ли Whisper».
    // Иначе выбор Яндекса ложно требует докачать локальную модель и блокирует
    // запись голосом (см. hasStt ниже).
    try {
      const diag = await api.sttProviders();
      const READY = new Set(['ready', 'available']);
      const active = diag.providers.find((p) => p.id === diag.default);
      const engineReady = !!active && active.available && READY.has(active.reason);
      // Локальный Whisper — фолбэк: если выбран облачный движок без ключа/гейтвея,
      // сервер прозрачно откатывается на Whisper (см. /stt/stream). Поэтому STT
      // «готов», когда готов активный движок ИЛИ доступен Whisper.
      const whisper = diag.providers.find((p) => p.id === 'whisper-local');
      const whisperReady = !!whisper && whisper.available && whisper.reason === 'ready';
      setSttReady(engineReady || whisperReady);
    } catch {
      setSttReady(false);
    }
    // Active engine drives the privacy pill (local Whisper vs cloud STT).
    try {
      setSttEngine((await api.getSttSettings()).engine);
    } catch {
      /* backend offline — keep the last known engine */
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

  // Падение/перезапуск бэкенда main сообщает мгновенно — не ждём 10-сек поллинг.
  useEffect(() => {
    const unsub = window.electronAPI?.onBackendStatus?.((status) => {
      setBackendStatus(status);
      if (status.state === 'ok') void refreshKeys();
    });
    return () => unsub?.();
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
        backendStatus,
        hasAnyKey,
        hasStt,
        sttEngine,
        onboardingDone,
        license,
        completeOnboarding,
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
