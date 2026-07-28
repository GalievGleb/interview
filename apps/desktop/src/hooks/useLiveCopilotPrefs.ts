import { useCallback, useEffect, useState } from 'react';
import type { LiveSources } from './useLiveCopilot';
import {
  LIVE_COPILOT_PREFS_KEY,
  loadLiveCopilotPrefs,
  prefsToSttOptions,
  saveLiveCopilotPrefs,
  type LiveCopilotPrefs,
} from '../lib/liveCopilotPrefs';
import type { AudioSampleRateMode, SttSessionOptions } from '../lib/sttOptions';

export function useLiveCopilotPrefs(): {
  sources: LiveSources;
  language: string;
  audioRate: AudioSampleRateMode;
  sttOptions: SttSessionOptions;
  toggleSource: (key: keyof LiveSources) => void;
  setSources: (sources: LiveSources) => void;
  setLanguage: (language: string) => void;
  setAudioRate: (rate: AudioSampleRateMode) => void;
} {
  const [prefs, setPrefsState] = useState<LiveCopilotPrefs>(loadLiveCopilotPrefs);

  // Настройки меняются и в другом окне (Settings в главном, hook в оверлее) —
  // storage-событие подтягивает свежие prefs без перезапуска окна.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LIVE_COPILOT_PREFS_KEY) setPrefsState(loadLiveCopilotPrefs());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const commit = useCallback((updater: LiveCopilotPrefs | ((prev: LiveCopilotPrefs) => LiveCopilotPrefs)) => {
    setPrefsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveLiveCopilotPrefs(next);
      return next;
    });
  }, []);

  const toggleSource = useCallback(
    (key: keyof LiveSources) => {
      commit((prev) => ({
        ...prev,
        sources: { ...prev.sources, [key]: !prev.sources[key] },
      }));
    },
    [commit],
  );

  const setSources = useCallback(
    (sources: LiveSources) => {
      commit((prev) => ({ ...prev, sources }));
    },
    [commit],
  );

  const setLanguage = useCallback(
    (language: string) => commit((prev) => ({ ...prev, language })),
    [commit],
  );
  const setAudioRate = useCallback(
    (audioRate: AudioSampleRateMode) => commit((prev) => ({ ...prev, audioRate })),
    [commit],
  );

  return {
    sources: prefs.sources,
    language: prefs.language,
    audioRate: prefs.audioRate,
    sttOptions: prefsToSttOptions(prefs),
    toggleSource,
    setSources,
    setLanguage,
    setAudioRate,
  };
}
