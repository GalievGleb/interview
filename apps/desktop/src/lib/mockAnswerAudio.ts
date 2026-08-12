import { getSelectedMicId } from './audioDevices';

export const MAX_MOCK_ANSWER_SECONDS = 120;
export const MAX_MOCK_ANSWER_CONTEXT_CHARS = 1_000;
export const MAX_MOCK_ANSWER_HINTS = 32;
export const MAX_MOCK_ANSWER_HINT_CHARS = 64;

const DEFAULT_QA_HINTS = [
  'API',
  'JSON',
  'HTTP',
  'HTTPX',
  'status code',
  'response body',
  'headers',
  'schema',
  'flaky',
  'UI',
  'Allure',
  'pytest',
  'fixture',
  'conftest',
  'Playwright',
  'Selenium',
  'Page Object',
  'GitLab',
  'CI/CD',
] as const;

export interface MockAnswerGuidance {
  question: string;
  hints: string[];
}

export interface MockAnswerRecording {
  sampleRate: number;
  stop(): Blob;
  cancel(): void;
}

interface MockAnswerRecordingOptions {
  onLimitReached?: () => void;
  onLevel?: (level: number) => void;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeHint(value: string): string {
  return compact(value.replace(/[<>\r\n]/g, ' ')).slice(0, MAX_MOCK_ANSWER_HINT_CHARS);
}

function latinTokens(value: string): string[] {
  return value.match(/[A-Za-z][A-Za-z0-9]*(?:[./+#-][A-Za-z0-9]+)*/g) ?? [];
}

export function buildMockAnswerGuidance(
  question: string,
  topicLabels: string[],
): MockAnswerGuidance {
  const compactQuestion = compact(question).slice(0, MAX_MOCK_ANSWER_CONTEXT_CHARS);
  const candidates = [
    ...latinTokens(compactQuestion),
    ...topicLabels.flatMap((label) => latinTokens(label)),
    ...topicLabels,
    ...DEFAULT_QA_HINTS,
  ];
  const seen = new Set<string>();
  const hints: string[] = [];

  for (const candidate of candidates) {
    const hint = safeHint(candidate);
    const key = hint.toLocaleLowerCase();
    if (!hint || seen.has(key)) continue;
    seen.add(key);
    hints.push(hint);
    if (hints.length >= MAX_MOCK_ANSWER_HINTS) break;
  }

  return { question: compactQuestion, hints };
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

export function encodePcm16MonoWav(chunks: ArrayBuffer[], sampleRate: number): Blob {
  const dataBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(44 + dataBytes);
  const view = new DataView(output.buffer);

  writeAscii(output, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(output, 8, 'WAVE');
  writeAscii(output, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(output, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const chunk of chunks) {
    output.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return new Blob([output], { type: 'audio/wav' });
}

export function mockAnswerMicConstraints(deviceId = getSelectedMicId()): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (deviceId) constraints.deviceId = { ideal: deviceId };
  return constraints;
}

function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

export async function startMockAnswerRecording(
  options: MockAnswerRecordingOptions = {},
): Promise<MockAnswerRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: mockAnswerMicConstraints(),
  });
  let context: AudioContext | null = null;

  try {
    context = new AudioContext();
    const audioContext = context;
    const sampleRate = Math.round(audioContext.sampleRate);
    const maxPcmBytes = sampleRate * 2 * MAX_MOCK_ANSWER_SECONDS;
    const chunks: ArrayBuffer[] = [];
    let capturedBytes = 0;
    let closed = false;
    let finalBlob: Blob | null = null;

    if (audioContext.state === 'suspended') await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const silent = audioContext.createGain();
    silent.gain.value = 0;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      silent.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    };

    processor.onaudioprocess = (event) => {
      if (closed || capturedBytes >= maxPcmBytes) return;
      const input = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let index = 0; index < input.length; index += 1) sum += input[index] * input[index];
      options.onLevel?.(Math.min(1, Math.sqrt(sum / Math.max(1, input.length)) * 7));
      const pcm = floatToPcm16(input);
      const remaining = maxPcmBytes - capturedBytes;
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, Math.min(pcm.byteLength, remaining));
      const copy = bytes.slice().buffer;
      chunks.push(copy);
      capturedBytes += copy.byteLength;
      if (capturedBytes >= maxPcmBytes) {
        cleanup();
        options.onLimitReached?.();
      }
    };

    source.connect(processor);
    processor.connect(silent);
    silent.connect(audioContext.destination);

    return {
      sampleRate,
      stop() {
        cleanup();
        finalBlob ??= encodePcm16MonoWav(chunks, sampleRate);
        return finalBlob;
      },
      cancel() {
        cleanup();
        chunks.length = 0;
      },
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    if (context) void context.close();
    throw error;
  }
}
