import { useCallback, useState } from 'react';
import type { LiveSources } from './useLiveCopilot';
import {
  loadLiveCopilotPrefs,
  prefsToSttOptions,
  saveLiveCopilotPrefs,
  type LiveCopilotPrefs,
} from '../lib/liveCopilotPrefs';
import type { SttMode } from '../lib/liveSession';
import type { AudioSampleRateMode, SttEngine, SttSessionOptions } from '../lib/sttOptions';

export function useLiveCopilotPrefs(): {
  sources: LiveSources;
  mode: SttMode;
  language: string;
  sttEngine: SttEngine;
  audioRate: AudioSampleRateMode;
  sttOptions: SttSessionOptions;
  toggleSource: (key: keyof LiveSources) => void;
  setSources: (sources: LiveSources) => void;
  setMode: (mode: SttMode) => void;
  setLanguage: (language: string) => void;
  setSttEngine: (engine: SttEngine) => void;
  setAudioRate: (rate: AudioSampleRateMode) => void;
} {
  const [prefs, setPrefsState] = useState<LiveCopilotPrefs>(loadLiveCopilotPrefs);

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

  const setMode = useCallback((mode: SttMode) => commit((prev) => ({ ...prev, mode })), [commit]);
  const setLanguage = useCallback(
    (language: string) => commit((prev) => ({ ...prev, language })),
    [commit],
  );
  const setSttEngine = useCallback(
    (sttEngine: SttEngine) => commit((prev) => ({ ...prev, sttEngine })),
    [commit],
  );
  const setAudioRate = useCallback(
    (audioRate: AudioSampleRateMode) => commit((prev) => ({ ...prev, audioRate })),
    [commit],
  );

  return {
    sources: prefs.sources,
    mode: prefs.mode,
    language: prefs.language,
    sttEngine: prefs.sttEngine,
    audioRate: prefs.audioRate,
    sttOptions: prefsToSttOptions(prefs),
    toggleSource,
    setSources,
    setMode,
    setLanguage,
    setSttEngine,
    setAudioRate,
  };
}
