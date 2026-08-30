export type MicrophoneSampleStatus = 'idle' | 'recording' | 'ready' | 'playing';

export interface MicrophoneSampleState {
  status: MicrophoneSampleStatus;
  elapsedMs: number;
  durationMs: number;
  level: number;
  error: string;
}

export type MicrophoneSampleAction =
  | { type: 'recording-started' }
  | { type: 'recording-progress'; elapsedMs: number; level: number }
  | { type: 'recording-ready'; durationMs: number }
  | { type: 'playback-started' }
  | { type: 'playback-stopped' }
  | { type: 'failed'; message: string }
  | { type: 'reset' };

export const INITIAL_MICROPHONE_SAMPLE_STATE: MicrophoneSampleState = {
  status: 'idle',
  elapsedMs: 0,
  durationMs: 0,
  level: 0,
  error: '',
};

interface MicrophoneRecorderLike {
  state: RecordingState;
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: Event & { error?: DOMException }) => void) | null;
  start(): void;
  stop(): void;
}

export interface MicrophoneSampleCapture {
  stream: MediaStream;
  stop(): Promise<Blob>;
  cancel(): void;
}

interface MicrophoneSampleCaptureDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createRecorder(stream: MediaStream, options?: MediaRecorderOptions): MicrophoneRecorderLike;
  isTypeSupported(mimeType: string): boolean;
}

export function createMicrophoneSampleConstraints(deviceId: string): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) constraints.deviceId = { ideal: deviceId };
  return constraints;
}

export function formatMicrophoneSampleDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function preferredMicrophoneSampleMimeType(isTypeSupported: (mimeType: string) => boolean): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(isTypeSupported) ?? '';
}

export async function startMicrophoneSampleCapture(
  deviceId: string,
  deps: MicrophoneSampleCaptureDeps = {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createRecorder: (stream, options) =>
      new MediaRecorder(stream, options) as unknown as MicrophoneRecorderLike,
    isTypeSupported: (mimeType) => MediaRecorder.isTypeSupported(mimeType),
  },
): Promise<MicrophoneSampleCapture> {
  const stream = await deps.getUserMedia({
    audio: createMicrophoneSampleConstraints(deviceId),
  });
  let recorder: MicrophoneRecorderLike;
  try {
    const mimeType = preferredMicrophoneSampleMimeType(deps.isTypeSupported);
    recorder = deps.createRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }

  const chunks: Blob[] = [];
  let cancelled = false;
  let settled = false;
  let resolveStopped!: (blob: Blob) => void;
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<Blob>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  const cleanup = () => stream.getTracks().forEach((track) => track.stop());
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
    const mimeType = recorder.mimeType || chunks[0]?.type || 'audio/webm';
    resolveStopped(cancelled ? new Blob([], { type: mimeType }) : new Blob(chunks, { type: mimeType }));
  };

  recorder.ondataavailable = (event) => {
    if (!cancelled && event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = finish;
  recorder.onerror = (event) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectStopped(event.error ?? new Error('Microphone recording failed'));
  };

  try {
    recorder.start();
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    stream,
    stop() {
      if (!settled && recorder.state !== 'inactive') recorder.stop();
      else finish();
      return stopped;
    },
    cancel() {
      cancelled = true;
      chunks.length = 0;
      if (!settled && recorder.state !== 'inactive') recorder.stop();
      else finish();
    },
  };
}

export function microphoneSampleReducer(
  state: MicrophoneSampleState,
  action: MicrophoneSampleAction,
): MicrophoneSampleState {
  switch (action.type) {
    case 'recording-started':
      return { ...INITIAL_MICROPHONE_SAMPLE_STATE, status: 'recording' };
    case 'recording-progress':
      if (state.status !== 'recording') return state;
      return { ...state, elapsedMs: action.elapsedMs, level: action.level };
    case 'recording-ready':
      return {
        status: 'ready',
        elapsedMs: action.durationMs,
        durationMs: action.durationMs,
        level: 0,
        error: '',
      };
    case 'playback-started':
      return state.status === 'ready' ? { ...state, status: 'playing' } : state;
    case 'playback-stopped':
      return state.status === 'playing' ? { ...state, status: 'ready' } : state;
    case 'failed':
      return { ...INITIAL_MICROPHONE_SAMPLE_STATE, error: action.message };
    case 'reset':
      return INITIAL_MICROPHONE_SAMPLE_STATE;
    default:
      return state;
  }
}
