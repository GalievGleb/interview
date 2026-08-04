export const QUESTION_SPEECH_MODEL = 'gpt-4o-mini-tts';
export const QUESTION_SPEECH_VOICE = 'marin';

export function normalizeQuestionSpeechText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function questionSpeechCacheKey(text: string, language: 'ru' | 'en'): string {
  return [
    QUESTION_SPEECH_MODEL,
    QUESTION_SPEECH_VOICE,
    language,
    normalizeQuestionSpeechText(text),
  ].join('|');
}

export function selectFallbackVoice(
  voices: SpeechSynthesisVoice[],
  language: 'ru' | 'en',
): SpeechSynthesisVoice | null {
  const prefix = language === 'ru' ? 'ru' : 'en';
  const matching = voices.filter((voice) => voice.lang.toLowerCase().startsWith(prefix));
  const score = (voice: SpeechSynthesisVoice) => {
    const name = voice.name.toLowerCase();
    return (
      (name.includes('natural') ? 100 : 0) +
      (name.includes('online') ? 40 : 0) +
      (!voice.localService ? 20 : 0) +
      (voice.default ? 5 : 0)
    );
  };
  return [...matching].sort((left, right) => score(right) - score(left))[0] ?? null;
}

interface SpeechVoiceSource {
  getVoices(): SpeechSynthesisVoice[];
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Chromium may expose an empty voice list until its voiceschanged event. */
export function waitForFallbackVoice(
  source: SpeechVoiceSource,
  language: 'ru' | 'en',
  timeoutMs = 350,
): Promise<SpeechSynthesisVoice | null> {
  const immediate = selectFallbackVoice(source.getVoices(), language);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (voice: SpeechSynthesisVoice | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      source.removeEventListener('voiceschanged', onVoicesChanged);
      resolve(voice);
    };
    const onVoicesChanged = () => {
      const voice = selectFallbackVoice(source.getVoices(), language);
      if (voice) finish(voice);
    };
    const timeout = setTimeout(
      () => finish(selectFallbackVoice(source.getVoices(), language)),
      timeoutMs,
    );
    source.addEventListener('voiceschanged', onVoicesChanged);
  });
}

export class QuestionSpeechUrlCache {
  private readonly entries = new Map<string, string>();

  constructor(
    private readonly limit = 20,
    private readonly revoke: (url: string) => void = URL.revokeObjectURL,
  ) {}

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, url: string): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      if (previous !== url) this.revoke(previous);
    }
    this.entries.set(key, url);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.entries().next().value as [string, string] | undefined;
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      this.revoke(oldest[1]);
    }
  }

  clear(): void {
    for (const url of this.entries.values()) this.revoke(url);
    this.entries.clear();
  }
}

export class QuestionSpeechLoader {
  private readonly inflight = new Map<string, Promise<string>>();
  private lifecycle = 0;

  constructor(
    private readonly synthesize: (text: string, language: 'ru' | 'en') => Promise<Blob>,
    private readonly createObjectUrl: (blob: Blob) => string = URL.createObjectURL,
    private readonly cache = new QuestionSpeechUrlCache(),
    private readonly revokeLateUrl: (url: string) => void = URL.revokeObjectURL,
  ) {}

  load(text: string, language: 'ru' | 'en'): Promise<string> {
    const normalized = normalizeQuestionSpeechText(text);
    const key = questionSpeechCacheKey(normalized, language);
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const lifecycle = this.lifecycle;
    const request = this.synthesize(normalized, language)
      .then((blob) => {
        const url = this.createObjectUrl(blob);
        if (lifecycle !== this.lifecycle) {
          this.revokeLateUrl(url);
          throw new Error('speech loader was cleared');
        }
        this.cache.set(key, url);
        return url;
      })
      .finally(() => {
        if (this.inflight.get(key) === request) this.inflight.delete(key);
      });
    this.inflight.set(key, request);
    return request;
  }

  clear(): void {
    this.lifecycle += 1;
    this.inflight.clear();
    this.cache.clear();
  }
}
