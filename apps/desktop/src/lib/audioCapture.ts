import { getSelectedMicId } from './audioDevices';
import { AudioSampleRateMode } from './sttOptions';

export interface AudioCapture {
  stop: () => void;
}

export type AudioSource = 'mic' | 'system';

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

function pipeStream(
  stream: MediaStream,
  onChunk: (buffer: ArrayBuffer) => void,
  sampleRateMode: AudioSampleRateMode,
): AudioCapture {
  const audioContext = new AudioContext();
  const nativeRate = audioContext.sampleRate;
  const outputRate = sampleRateMode === '48k-native' ? nativeRate : 16000;
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silent = audioContext.createGain();
  silent.gain.value = 0;

  processor.onaudioprocess = (event) => {
    const raw = event.inputBuffer.getChannelData(0);
    const samples = nativeRate !== outputRate ? resample(raw, nativeRate, outputRate) : raw;
    const pcm16 = floatTo16BitPCM(samples);
    onChunk(pcm16.buffer as ArrayBuffer);
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
  onChunk: (buffer: ArrayBuffer) => void,
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
  onChunk: (buffer: ArrayBuffer) => void,
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
  onChunk: (buffer: ArrayBuffer) => void,
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
