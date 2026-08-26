import { getSelectedMicId } from './audioDevices';
import { AudioSampleRateMode } from './sttOptions';

export interface AudioCapture {
  stop: () => void;
}

export type AudioSource = 'mic' | 'system';

export interface AudioFrameSignal {
  capturedAtMs: number;
  rms: number;
  peak: number;
  hasSignal: boolean;
}

export const PCM16_SIGNAL_RMS_THRESHOLD = 512 / 0x8000;
export const AUDIO_SIGNAL_SAMPLE_INTERVAL_MS = 250;

export interface CaptureOptions {
  sampleRateMode: AudioSampleRateMode;
}

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[idx + 1] ?? s0;
    output[i] = s0 + (s1 - s0) * frac;
  }
  return output;
}

export function analyzePcm16Signal(
  pcm16: Int16Array,
  capturedAtMs = Date.now(),
): AudioFrameSignal {
  if (pcm16.length === 0) {
    return { capturedAtMs, rms: 0, peak: 0, hasSignal: false };
  }

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < pcm16.length; i += 1) {
    const normalized = pcm16[i] / 0x8000;
    const magnitude = Math.abs(normalized);
    sumSquares += normalized * normalized;
    if (magnitude > peak) peak = magnitude;
  }
  const rms = Math.sqrt(sumSquares / pcm16.length);
  return {
    capturedAtMs,
    rms,
    peak,
    hasSignal: rms >= PCM16_SIGNAL_RMS_THRESHOLD,
  };
}

export function createAudioSignalSampler(
  intervalMs = AUDIO_SIGNAL_SAMPLE_INTERVAL_MS,
): (pcm16: Int16Array, capturedAtMs?: number) => AudioFrameSignal | undefined {
  let lastSampleAtMs = Number.NEGATIVE_INFINITY;
  return (pcm16, capturedAtMs = Date.now()) => {
    if (capturedAtMs - lastSampleAtMs < intervalMs) return undefined;
    lastSampleAtMs = capturedAtMs;
    return analyzePcm16Signal(pcm16, capturedAtMs);
  };
}

function pipeStream(
  stream: MediaStream,
  onChunk: (buffer: ArrayBuffer, signal?: AudioFrameSignal) => void,
  sampleRateMode: AudioSampleRateMode,
): AudioCapture {
  const audioContext = new AudioContext();
  const nativeRate = audioContext.sampleRate;
  const outputRate = sampleRateMode === '48k-native' ? nativeRate : 16000;
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silent = audioContext.createGain();
  const sampleSignal = createAudioSignalSampler();
  silent.gain.value = 0;

  processor.onaudioprocess = (event) => {
    const raw = event.inputBuffer.getChannelData(0);
    const samples = nativeRate !== outputRate ? resample(raw, nativeRate, outputRate) : raw;
    const pcm16 = floatTo16BitPCM(samples);
    onChunk(pcm16.buffer as ArrayBuffer, sampleSignal(pcm16));
  };

  source.connect(processor);
  processor.connect(silent);
  silent.connect(audioContext.destination);

  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());

  return {
    stop: () => {
      processor.disconnect();
      source.disconnect();
      silent.disconnect();
      void audioContext.close();
      stopTracks();
    },
  };
}

export async function startMicCapture(
  onChunk: (buffer: ArrayBuffer, signal?: AudioFrameSignal) => void,
  opts: CaptureOptions,
): Promise<AudioCapture> {
  const deviceId = getSelectedMicId();
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
  };
  if (deviceId) audio.deviceId = { ideal: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  return pipeStream(stream, onChunk, opts.sampleRateMode);
}

export async function startSystemAudioCapture(
  onChunk: (buffer: ArrayBuffer, signal?: AudioFrameSignal) => void,
  opts: CaptureOptions,
): Promise<AudioCapture> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('Системный звук недоступен (нет аудио-дорожки)');
  }

  if (!isElectron) {
    stream.getVideoTracks().forEach((t) => t.stop());
  }

  const audioStream = isElectron ? stream : new MediaStream(audioTracks);
  return pipeStream(audioStream, onChunk, opts.sampleRateMode);
}

export async function startCapture(
  source: AudioSource,
  onChunk: (buffer: ArrayBuffer, signal?: AudioFrameSignal) => void,
  opts: CaptureOptions,
): Promise<AudioCapture> {
  return source === 'system'
    ? startSystemAudioCapture(onChunk, opts)
    : startMicCapture(onChunk, opts);
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}
