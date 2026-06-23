/** Опции A/B-тестирования STT (не менять всё сразу). */

export type SttEngine = 'nova3-multi' | 'flux-multi' | 'nova2-ru-legacy';

export type AudioSampleRateMode = '16k' | '48k-native';

export interface SttSessionOptions {
  mode?: 'fast' | 'stable';
  language?: string;
  engine?: SttEngine;
  audioSampleRate?: AudioSampleRateMode;
}

export const STT_ENGINE_LABELS: Record<SttEngine, string> = {
  'nova3-multi': 'Nova-3 Multi',
  'flux-multi': 'Flux Multi',
  'nova2-ru-legacy': 'Nova-2 RU Legacy',
};

export const AUDIO_RATE_LABELS: Record<AudioSampleRateMode, string> = {
  '16k': 'PCM16 16k resampled',
  '48k-native': 'PCM16 native (48k/44.1k)',
};

/** Определяет sample rate до открытия WebSocket. */
export async function probeOutputSampleRate(mode: AudioSampleRateMode): Promise<number> {
  const ctx = new AudioContext();
  const native = Math.round(ctx.sampleRate);
  await ctx.close();
  return mode === '48k-native' ? native : 16000;
}
