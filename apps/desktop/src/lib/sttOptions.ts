export type AudioSampleRateMode = '16k' | '48k-native';

export interface SttSessionOptions {
  language?: string;
  audioSampleRate?: AudioSampleRateMode;
}

export const AUDIO_RATE_LABELS: Record<AudioSampleRateMode, string> = {
  '16k': 'PCM16 16 kHz',
  '48k-native': 'PCM16 native',
};

export async function probeOutputSampleRate(mode: AudioSampleRateMode): Promise<number> {
  const context = new AudioContext();
  const nativeRate = Math.round(context.sampleRate);
  await context.close();
  return mode === '48k-native' ? nativeRate : 16000;
}
