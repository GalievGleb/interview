import { api, getApiToken } from './api';
import {
  startCapture,
  AudioCapture,
  AudioSource,
  type AudioFrameSignal,
} from './audioCapture';
import {
  AudioSampleRateMode,
  probeOutputSampleRate,
  SttSessionOptions,
} from './sttOptions';

const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;

/**
 * Захват, только что открытый в ws.onopen, «осиротел», если за время
 * асинхронного startCapture соединение остановили или пересоздали. Такой
 * захват нужно немедленно гасить, иначе микрофон/экран останутся включены.
 */
export function captureIsStale(
  stopped: boolean,
  currentWs: WebSocket | null,
  myWs: WebSocket | null,
  paused = false,
  currentCaptureEpoch?: number,
  myCaptureEpoch?: number,
): boolean {
  return (
    paused ||
    stopped ||
    !myWs ||
    currentWs !== myWs ||
    myWs.readyState !== WEBSOCKET_OPEN ||
    (currentCaptureEpoch != null &&
      myCaptureEpoch != null &&
      currentCaptureEpoch !== myCaptureEpoch)
  );
}

export function sendFinalizeControl(ws: WebSocket | null, requestId: string): boolean {
  if (!ws || ws.readyState !== WEBSOCKET_OPEN) return false;
  ws.send(JSON.stringify({ type: 'finalize', request_id: requestId }));
  return true;
}

const RECOVERABLE_STT_ERROR =
  'Не удалось распознать этот фрагмент. Продолжаю слушать — повторите фразу.';

/** Old backends used a fatal `error` frame for a transient provider outage. */
export function recoverableSttErrorMessage(message: unknown): string | null {
  const value = String(message ?? '').trim();
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (
    /openai mini stt (429|5\d\d)/i.test(value) ||
    normalized.includes('internal server error') ||
    normalized.includes('сервис распознавания временно недоступен')
  ) {
    return RECOVERABLE_STT_ERROR;
  }
  return null;
}

/** Server-measured timing breakdown for one utterance (ms). */
export interface SttTimings {
  speechMs?: number;
  firstPartialMs?: number | null;
  speechEndToFinalMs?: number;
  openaiInferenceMs?: number;
  /** @deprecated compatibility with older diagnostic payloads. */
  finalInferenceMs?: number;
  queueWaitMs?: number;
  queueDepth?: number;
  partialCount?: number;
}

export interface SttTranscriptMetadata {
  forceRequestId?: string;
  utteranceId?: string;
  capturedAtMs?: number;
  queueWaitMs?: number;
  queueDepth?: number;
  speechEndToFinalMs?: number;
  openaiInferenceMs?: number;
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export function parseSttTranscriptMetadata(event: Record<string, unknown>): SttTranscriptMetadata {
  return {
    forceRequestId:
      typeof event.force_request_id === 'string' && event.force_request_id
        ? event.force_request_id
        : undefined,
    utteranceId:
      typeof event.utterance_id === 'string' && event.utterance_id
        ? event.utterance_id
        : undefined,
    capturedAtMs: finiteNumber(event.captured_at_ms),
    queueWaitMs: finiteNumber(event.queueWaitMs),
    queueDepth: finiteNumber(event.queueDepth),
    speechEndToFinalMs: finiteNumber(event.speechEndToFinalMs),
    openaiInferenceMs: finiteNumber(event.openaiInferenceMs),
  };
}

export interface LiveHandlers {
  onTranscript: (
    text: string,
    isFinal: boolean,
    speechFinal: boolean,
    metadata?: SttTranscriptMetadata,
  ) => void;
  onUtteranceEnd?: (timings?: SttTimings, forceRequestId?: string) => void;
  onTurnResumed?: () => void;
  onSpeechStarted?: (captureEpoch: number) => void;
  /** Connection dropped — reconnect attempt N of M is scheduled. */
  onReconnecting?: (attempt: number, maxAttempts: number) => void;
  /** Connection restored after a reconnect (server sent `ready` again). */
  onReconnected?: () => void;
  /** Final transcript rejected by the server quality gate (no LLM call). */
  onLowQuality?: (
    text: string,
    reason: string,
    forceRequestId?: string,
    metadata?: SttTranscriptMetadata,
  ) => void;
  /** Manual finalize reached the server, but there was no buffered audio. */
  onForceEmpty?: (forceRequestId?: string) => void;
  onReady?: (info: {
    engine: string;
    model: string;
    sampleRate: number;
  }) => void;
  /** OS capture permission resolved and this capture epoch is producing frames. */
  onCaptureReady?: (info: { capturedAtMs: number; captureEpoch: number }) => void;
  onError: (message: string) => void;
  /** One utterance failed upstream, but capture and the socket remain active. */
  onRecoverableError?: (message: string) => void;
  onClose?: () => void;
  /** Tee of each raw PCM16 frame sent to the server (for the debug recorder). */
  onAudioFrame?: (
    buffer: ArrayBuffer,
    signal: AudioFrameSignal | undefined,
    captureEpoch: number,
  ) => void;
}

export interface LiveSession {
  flush: (requestId: string) => boolean;
  stopCapture: () => void;
  pause: () => void;
  resume: () => Promise<void>;
  stop: () => void;
}

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}

export async function startLiveSession(
  handlers: LiveHandlers,
  opts: {
    sessionId?: string;
    speaker?: string;
    source?: AudioSource;
  } & SttSessionOptions = {},
): Promise<LiveSession> {
  const source: AudioSource = opts.source ?? 'mic';
  const audioMode: AudioSampleRateMode = opts.audioSampleRate ?? '16k';
  const sampleRate = await probeOutputSampleRate(audioMode);

  const params = new URLSearchParams();
  if (opts.sessionId) params.set('session_id', opts.sessionId);
  if (opts.speaker) params.set('speaker', opts.speaker);
  if (opts.language) params.set('language', opts.language);
  params.set('sample_rate', String(sampleRate));
  // Локальная аутентификация: браузерный WebSocket не умеет заголовки.
  const apiToken = await getApiToken();
  if (apiToken) params.set('token', apiToken);

  const wsUrl = `${toWsUrl(api.apiUrl)}/stt/stream?${params.toString()}`;

  let ws: WebSocket | null = null;
  let capture: AudioCapture | null = null;
  let captureStarting: Promise<void> | null = null;
  let stopped = false;
  let paused = false;
  let attempts = 0;
  let reconnectTimer: number | null = null;
  let captureEpoch = 0;
  const MAX_RECONNECT = 5;

  const stopCapture = () => {
    captureEpoch += 1;
    capture?.stop();
    capture = null;
  };

  const startAudioCapture = (myWs: WebSocket | null): Promise<void> => {
    if (
      stopped ||
      paused ||
      capture ||
      !myWs ||
      myWs.readyState !== WEBSOCKET_OPEN
    ) {
      return captureStarting ?? Promise.resolve();
    }
    if (captureStarting) {
      const existingStart = captureStarting;
      return existingStart.then(() => startAudioCapture(myWs));
    }
    const myCaptureEpoch = captureEpoch + 1;
    captureEpoch = myCaptureEpoch;

    const pending = (async () => {
      try {
        const cap = await startCapture(
          source,
          (buffer, signal) => {
            if (captureIsStale(stopped, ws, myWs, paused, captureEpoch, myCaptureEpoch)) {
              return;
            }
            if (myWs.readyState === WEBSOCKET_OPEN) myWs.send(buffer);
            handlers.onAudioFrame?.(buffer, signal, myCaptureEpoch);
          },
          { sampleRateMode: audioMode },
        );
        if (captureIsStale(stopped, ws, myWs, paused, captureEpoch, myCaptureEpoch)) {
          // Pause/stop/reconnect could happen while the OS permission dialog was open.
          cap.stop();
          return;
        }
        capture = cap;
        handlers.onCaptureReady?.({ capturedAtMs: Date.now(), captureEpoch: myCaptureEpoch });
      } catch (err) {
        if (stopped || paused) return;
        handlers.onError(err instanceof Error ? err.message : 'Нет доступа к источнику звука');
        cleanup();
      }
    })();

    captureStarting = pending;
    void pending.finally(() => {
      if (captureStarting === pending) captureStarting = null;
    });
    return pending;
  };

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopCapture();
    if (
      ws &&
      (ws.readyState === WEBSOCKET_OPEN || ws.readyState === WEBSOCKET_CONNECTING)
    ) {
      ws.close();
    }
    ws = null;
  };

  const scheduleReconnect = () => {
    if (stopped || paused) return;
    if (attempts >= MAX_RECONNECT) {
      handlers.onError('Соединение со звуком потеряно — переподключение не удалось.');
      handlers.onClose?.();
      return;
    }
    const delay = Math.min(500 * 2 ** attempts, 5000);
    attempts += 1;
    handlers.onReconnecting?.(attempts, MAX_RECONNECT);
    reconnectTimer = window.setTimeout(connect, delay);
  };

  function connect() {
    if (stopped || paused) return;
    const socket = new WebSocket(wsUrl);
    ws = socket;
    socket.binaryType = 'arraybuffer';

    socket.onopen = async () => {
      if (stopped || paused || ws !== socket) return;
      // startCapture асинхронный (getUserMedia/getDisplayMedia — до нескольких
      // секунд). Пока идёт await, соединение могло закрыться и пересоздаться;
      // фиксируем «своё» ws, чтобы не осиротить только что открытый захват.
      await startAudioCapture(socket);
    };

    socket.onmessage = (event) => {
      if (stopped || paused || ws !== socket) return;
      try {
        const evt = JSON.parse(event.data as string);
        if (evt.type === 'transcript') {
          handlers.onTranscript(
            evt.text,
            Boolean(evt.is_final),
            Boolean(evt.speech_final),
            parseSttTranscriptMetadata(evt),
          );
        } else if (evt.type === 'utterance_end') {
          handlers.onUtteranceEnd?.(
            evt.timings as SttTimings | undefined,
            evt.force_request_id,
          );
        } else if (evt.type === 'low_quality') {
          handlers.onLowQuality?.(
            evt.text ?? '',
            evt.reason ?? 'low_quality',
            evt.force_request_id,
            parseSttTranscriptMetadata(evt),
          );
        } else if (evt.type === 'force_empty') {
          handlers.onForceEmpty?.(evt.force_request_id);
        } else if (evt.type === 'speech_started') {
          handlers.onSpeechStarted?.(captureEpoch);
        } else if (evt.type === 'turn_resumed') {
          handlers.onTurnResumed?.();
        } else if (evt.type === 'ready') {
          const wasReconnect = attempts > 0;
          attempts = 0; // healthy connection — reset the backoff
          if (wasReconnect) handlers.onReconnected?.();
          handlers.onReady?.({
            engine: evt.engine ?? 'openai-mini',
            model: evt.model ?? 'gpt-4o-mini-transcribe',
            sampleRate: evt.sample_rate ?? sampleRate,
          });
        } else if (evt.type === 'transcription_error') {
          handlers.onRecoverableError?.(evt.message || RECOVERABLE_STT_ERROR);
        } else if (evt.type === 'error') {
          const recoverable = recoverableSttErrorMessage(evt.message);
          if (recoverable) handlers.onRecoverableError?.(recoverable);
          else {
            handlers.onError(evt.message);
            cleanup();
          }
        }
      } catch {
        // ignore non-JSON
      }
    };

    // Stay quiet on transient errors — onclose drives the bounded reconnect.
    socket.onerror = () => {
      if (stopped || paused || ws !== socket) return;
    };

    socket.onclose = () => {
      if (stopped || paused || ws !== socket) return;
      ws = null;
      stopCapture();
      scheduleReconnect();
    };
  }

  connect();

  return {
    flush: (requestId) => sendFinalizeControl(ws, requestId),
    stopCapture,
    pause: () => {
      if (stopped) return;
      paused = true;
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopCapture();
      const socket = ws;
      ws = null;
      if (
        socket &&
        (socket.readyState === WEBSOCKET_OPEN ||
          socket.readyState === WEBSOCKET_CONNECTING)
      ) {
        socket.close();
      }
    },
    resume: async () => {
      if (stopped) return;
      paused = false;
      if (!ws && reconnectTimer == null) connect();
    },
    stop: cleanup,
  };
}
