import type { LiveSources } from '../hooks/useLiveCopilot';
import type { AudioSampleRateMode, SttSessionOptions } from './sttOptions';

export const LIVE_COPILOT_PREFS_KEY = 'copilot-live-prefs';

const AUDIO_RATES: AudioSampleRateMode[] = ['16k', '48k-native'];
export interface LiveCopilotPrefs {
  sources: LiveSources;
  language: string;
  audioRate: AudioSampleRateMode;
}

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

export function defaultLiveCopilotPrefs(): LiveCopilotPrefs {
  return {
    sources: { mic: true, system: isElectron() },
    language: 'ru',
    audioRate: '16k',
  };
}

function isAudioRate(value: unknown): value is AudioSampleRateMode {
  return typeof value === 'string' && AUDIO_RATES.includes(value as AudioSampleRateMode);
}

function parseSources(raw: unknown, fallback: LiveSources): LiveSources {
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Record<string, unknown>;
  return {
    mic: typeof value.mic === 'boolean' ? value.mic : fallback.mic,
    system: typeof value.system === 'boolean' ? value.system : fallback.system,
  };
}

export function loadLiveCopilotPrefs(): LiveCopilotPrefs {
  const defaults = defaultLiveCopilotPrefs();
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem(LIVE_COPILOT_PREFS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<LiveCopilotPrefs> & {
      sttEngine?: unknown;
    };
    return {
      sources: parseSources(parsed.sources, defaults.sources),
      language:
        typeof parsed.language === 'string' && parsed.language.trim()
          ? parsed.language
          : defaults.language,
      audioRate: isAudioRate(parsed.audioRate) ? parsed.audioRate : defaults.audioRate,
    };
  } catch {
    return defaults;
  }
}

export function saveLiveCopilotPrefs(prefs: LiveCopilotPrefs): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(LIVE_COPILOT_PREFS_KEY, JSON.stringify(prefs));
}

export function prefsToSttOptions(prefs: LiveCopilotPrefs): SttSessionOptions {
  return {
    language: prefs.language,
    audioSampleRate: prefs.audioRate,
  };
}
