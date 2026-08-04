import { describe, expect, it, vi } from 'vitest';
import {
  QuestionSpeechUrlCache,
  QuestionSpeechLoader,
  questionSpeechCacheKey,
  selectFallbackVoice,
  waitForFallbackVoice,
} from './questionSpeech';

const voice = (
  name: string,
  lang: string,
  localService: boolean,
): SpeechSynthesisVoice => ({
  default: false,
  lang,
  localService,
  name,
  voiceURI: name,
});

describe('question speech helpers', () => {
  it('normalizes equivalent text into one model and voice cache key', () => {
    expect(questionSpeechCacheKey('  Что   такое API? ', 'ru')).toBe(
      questionSpeechCacheKey('Что такое API?', 'ru'),
    );
    expect(questionSpeechCacheKey('Что такое API?', 'ru')).toContain(
      'gpt-4o-mini-tts|marin|ru|',
    );
  });

  it('prefers a matching online natural voice over an arbitrary desktop voice', () => {
    const voices = [
      voice('Microsoft Irina Desktop', 'ru-RU', true),
      voice('Microsoft Svetlana Online (Natural)', 'ru-RU', false),
    ];
    expect(selectFallbackVoice(voices, 'ru')?.name).toContain('Natural');
  });

  it('never selects English for Russian while a Russian voice exists', () => {
    const voices = [
      voice('English Natural', 'en-US', false),
      voice('Русский голос', 'ru-RU', true),
    ];
    expect(selectFallbackVoice(voices, 'ru')?.lang).toBe('ru-RU');
  });

  it('evicts and revokes the least recently used object URL', () => {
    const revoke = vi.fn();
    const cache = new QuestionSpeechUrlCache(2, revoke);
    cache.set('first', 'blob:first');
    cache.set('second', 'blob:second');
    expect(cache.get('first')).toBe('blob:first');
    cache.set('third', 'blob:third');

    expect(cache.get('second')).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith('blob:second');
    expect(cache.get('first')).toBe('blob:first');
    expect(cache.get('third')).toBe('blob:third');
  });

  it('deduplicates prefetch and play while one managed WAV is loading', async () => {
    let resolve!: (blob: Blob) => void;
    const synthesize = vi.fn(
      () => new Promise<Blob>((done) => {
        resolve = done;
      }),
    );
    const loader = new QuestionSpeechLoader(
      synthesize,
      (blob) => `blob:${blob.size}`,
      new QuestionSpeechUrlCache(20, vi.fn()),
    );

    const prefetch = loader.load('Что такое API?', 'ru');
    const play = loader.load(' Что  такое API? ', 'ru');
    expect(synthesize).toHaveBeenCalledOnce();
    resolve(new Blob(['RIFF-wav']));

    await expect(prefetch).resolves.toBe('blob:8');
    await expect(play).resolves.toBe('blob:8');
    await expect(loader.load('Что такое API?', 'ru')).resolves.toBe('blob:8');
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it('revokes a URL created by an in-flight request after the loader was cleared', async () => {
    let resolve!: (blob: Blob) => void;
    const revoke = vi.fn();
    const loader = new QuestionSpeechLoader(
      () => new Promise<Blob>((done) => {
        resolve = done;
      }),
      () => 'blob:late',
      new QuestionSpeechUrlCache(20, revoke),
      revoke,
    );

    const pending = loader.load('Что такое API?', 'ru');
    loader.clear();
    resolve(new Blob(['RIFF']));

    await expect(pending).rejects.toThrow('speech loader was cleared');
    expect(revoke).toHaveBeenCalledWith('blob:late');
  });

  it('keeps a newer same-question request registered when an old cleared request settles', async () => {
    const resolvers: Array<(blob: Blob) => void> = [];
    const synthesize = vi.fn(
      () => new Promise<Blob>((done) => {
        resolvers.push(done);
      }),
    );
    let objectUrlIndex = 0;
    const loader = new QuestionSpeechLoader(
      synthesize,
      () => `blob:${++objectUrlIndex}`,
      new QuestionSpeechUrlCache(20, vi.fn()),
      vi.fn(),
    );

    const stale = loader.load('What is API?', 'en');
    loader.clear();
    const current = loader.load('What is API?', 'en');
    resolvers[0](new Blob(['old']));
    await expect(stale).rejects.toThrow('speech loader was cleared');

    const deduplicated = loader.load('What is API?', 'en');
    expect(deduplicated).toBe(current);
    expect(synthesize).toHaveBeenCalledTimes(2);
    resolvers[1](new Blob(['new']));
    await expect(current).resolves.toBe('blob:2');
  });

  it('waits for voiceschanged when Chromium initially exposes no voices', async () => {
    let voices: SpeechSynthesisVoice[] = [];
    const listeners: Array<() => void> = [];
    const synth = {
      getVoices: () => voices,
      addEventListener: (_name: string, next: () => void) => {
        listeners.push(next);
      },
      removeEventListener: vi.fn(),
    };

    const pending = waitForFallbackVoice(synth, 'ru', 5_000);
    voices = [voice('Microsoft Svetlana Online (Natural)', 'ru-RU', false)];
    listeners[0]?.();

    await expect(pending).resolves.toMatchObject({ lang: 'ru-RU' });
    expect(synth.removeEventListener).toHaveBeenCalled();
  });
});
