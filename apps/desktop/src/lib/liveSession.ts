import { api, getApiToken } from './api';
import { startCapture, AudioCapture, AudioSource } from './audioCapture';
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
): boolean {
  return stopped || !myWs || currentWs !== myWs || myWs.readyState !== WEBSOCKET_OPEN;
}

export function sendFinalizeControl(ws: WebSocket | null, requestId: string): boolean {
  if (!ws || ws.readyState !== WEBSOCKET_OPEN) return false;
  ws.send(JSON.stringify({ type: 'finalize', request_id: requestId }));
  return true;
}

/** Server-measured timing breakdown for one utterance (ms). */
export interface SttTimings {
  speechMs?: number;
  firstPartialMs?: number | null;
  speechEndToFinalMs?: number;
  finalInferenceMs?: number;
  partialCount?: number;
}

export interface LiveHandlers {
  onTranscript: (
    text: string,
    isFinal: boolean,
    speechFinal: boolean,
    forceRequestId?: string,
  ) => void;
  onUtteranceEnd?: (timings?: SttTimings, forceRequestId?: string) => void;
  onTurnResumed?: () => void;
  onSpeechStarted?: () => void;
  /** Connection dropped — reconnect attempt N of M is scheduled. */
  onReconnecting?: (attempt: number, maxAttempts: number) => void;
  /** Connection restored after a reconnect (server sent `ready` again). */
  onReconnected?: () => void;
  /** Final transcript rejected by the server quality gate (no LLM call). */
  onLowQuality?: (text: string, reason: string, forceRequestId?: string) => void;
  /** Manual finalize reached the server, but there was no buffered audio. */
  onForceEmpty?: (forceRequestId?: string) => void;
  onReady?: (info: {
    engine: string;
    model: string;
    sampleRate: number;
  }) => void;
  onError: (message: string) => void;
  onClose?: () => void;
  /** Tee of each raw PCM16 frame sent to the server (for the debug recorder). */
  onAudioFrame?: (buffer: ArrayBuffer) => void;
}

export interface LiveSession {
  flush: (requestId: string) => boolean;
  stopCapture: () => void;
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
  let stopped = false;
  let attempts = 0;
  let reconnectTimer: number | null = null;
  const MAX_RECONNECT = 5;

  const stopCapture = () => {
    capture?.stop();
    capture = null;
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
    if (stopped) return;
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
    if (stopped) return;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      // startCapture асинхронный (getUserMedia/getDisplayMedia — до нескольких
      // секунд). Пока идёт await, соединение могло закрыться и пересоздаться;
      // фиксируем «своё» ws, чтобы не осиротить только что открытый захват.
      const myWs = ws;
      try {
        const cap = await startCapture(
          source,
          (buffer) => {
            if (ws && ws.readyState === WEBSOCKET_OPEN) ws.send(buffer);
            handlers.onAudioFrame?.(buffer);
          },
          { sampleRateMode: audioMode },
        );
        if (captureIsStale(stopped, ws, myWs)) {
          // Соединение сменилось/закрылось за время await — этот захват
          // осиротел бы (микрофон/экран остались бы включены). Гасим сразу.
          cap.stop();
          return;
        }
        capture = cap;
      } catch (err) {
        handlers.onError(err instanceof Error ? err.message : 'Нет доступа к источнику звука');
        cleanup();
      }
    };

    ws.onmessage = (event) => {
      try {
        const evt = JSON.parse(event.data as string);
        if (evt.type === 'transcript') {
          handlers.onTranscript(
            evt.text,
            Boolean(evt.is_final),
            Boolean(evt.speech_final),
            evt.force_request_id,
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
          );
        } else if (evt.type === 'force_empty') {
          handlers.onForceEmpty?.(evt.force_request_id);
        } else if (evt.type === 'speech_started') {
          handlers.onSpeechStarted?.();
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
        } else if (evt.type === 'error') {
          handlers.onError(evt.message);
          cleanup();
        }
      } catch {
        // ignore non-JSON
      }
    };

    // Stay quiet on transient errors — onclose drives the bounded reconnect.
    ws.onerror = () => {};

    ws.onclose = () => {
      stopCapture();
      if (stopped) return;
      scheduleReconnect();
    };
  }

  connect();

  return {
    flush: (requestId) => sendFinalizeControl(ws, requestId),
    stopCapture,
    stop: cleanup,
  };
}
