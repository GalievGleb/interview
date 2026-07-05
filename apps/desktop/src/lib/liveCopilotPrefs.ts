import type { LiveSources } from '../hooks/useLiveCopilot';
import type { SttMode } from './liveSession';
import type { AudioSampleRateMode, SttEngine, SttSessionOptions } from './sttOptions';

/** Экспорт для cross-window синхронизации (настройки ⇄ оверлей ⇄ Live). */
export const LIVE_COPILOT_PREFS_KEY = 'copilot-live-prefs';

const STORAGE_KEY = LIVE_COPILOT_PREFS_KEY;

const STT_ENGINES: SttEngine[] = ['nova3-multi', 'flux-multi', 'nova2-ru-legacy'];
const AUDIO_RATES: AudioSampleRateMode[] = ['16k', '48k-native'];
const MODES: SttMode[] = ['fast', 'stable'];

export interface LiveCopilotPrefs {
  sources: LiveSources;
  mode: SttMode;
  language: string;
  sttEngine: SttEngine;
  audioRate: AudioSampleRateMode;
}

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

export function defaultLiveCopilotPrefs(): LiveCopilotPrefs {
  return {
    sources: { mic: true, system: isElectron() },
    mode: 'stable',
    language: 'ru',
    sttEngine: 'nova3-multi',
    audioRate: '16k',
  };
}

function isSttEngine(value: unknown): value is SttEngine {
  return typeof value === 'string' && STT_ENGINES.includes(value as SttEngine);
}

function isAudioRate(value: unknown): value is AudioSampleRateMode {
  return typeof value === 'string' && AUDIO_RATES.includes(value as AudioSampleRateMode);
}

function isMode(value: unknown): value is SttMode {
  return typeof value === 'string' && MODES.includes(value as SttMode);
}

function parseSources(raw: unknown, fallback: LiveSources): LiveSources {
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  return {
    mic: typeof obj.mic === 'boolean' ? obj.mic : fallback.mic,
    system: typeof obj.system === 'boolean' ? obj.system : fallback.system,
  };
}

export function loadLiveCopilotPrefs(): LiveCopilotPrefs {
  const defaults = defaultLiveCopilotPrefs();
  if (typeof localStorage === 'undefined') return defaults;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<LiveCopilotPrefs>;
    return {
      sources: parseSources(parsed.sources, defaults.sources),
      mode: isMode(parsed.mode) ? parsed.mode : defaults.mode,
      language: typeof parsed.language === 'string' && parsed.language.trim() ? parsed.language : defaults.language,
      sttEngine: isSttEngine(parsed.sttEngine) ? parsed.sttEngine : defaults.sttEngine,
      audioRate: isAudioRate(parsed.audioRate) ? parsed.audioRate : defaults.audioRate,
    };
  } catch {
    return defaults;
  }
}

export function saveLiveCopilotPrefs(prefs: LiveCopilotPrefs): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function prefsToSttOptions(prefs: LiveCopilotPrefs): SttSessionOptions {
  return {
    mode: prefs.mode,
    language: prefs.language,
    engine: prefs.sttEngine,
    audioSampleRate: prefs.audioRate,
  };
}
