import { api } from './api';
import { startCapture, AudioCapture, AudioSource } from './audioCapture';
import {
  AudioSampleRateMode,
  probeOutputSampleRate,
  SttEngine,
  SttSessionOptions,
} from './sttOptions';

/** Server-measured timing breakdown for one utterance (ms). */
export interface SttTimings {
  speechMs?: number;
  firstPartialMs?: number | null;
  speechEndToFinalMs?: number;
  finalInferenceMs?: number;
  partialCount?: number;
}

export interface LiveHandlers {
  onTranscript: (text: string, isFinal: boolean, speechFinal: boolean) => void;
  onUtteranceEnd?: (timings?: SttTimings) => void;
  onTurnResumed?: () => void;
  onSpeechStarted?: () => void;
  /** Final transcript rejected by the server quality gate (no LLM call). */
  onLowQuality?: (text: string, reason: string) => void;
  onReady?: (info: {
    engine: string;
    model: string;
    partialModel?: string;
    finalModel?: string;
    sampleRate: number;
  }) => void;
  onError: (message: string) => void;
  onClose?: () => void;
  /** Tee of each raw PCM16 frame sent to the server (for the debug recorder). */
  onAudioFrame?: (buffer: ArrayBuffer) => void;
}

export interface LiveSession {
  stop: () => void;
}

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}

export type SttMode = 'fast' | 'stable';

export async function startLiveSession(
  handlers: LiveHandlers,
  opts: {
    sessionId?: string;
    speaker?: string;
    source?: AudioSource;
  } & SttSessionOptions = {},
): Promise<LiveSession> {
  const source: AudioSource = opts.source ?? 'mic';
  const engine: SttEngine = opts.engine ?? 'nova3-multi';
  const audioMode: AudioSampleRateMode = opts.audioSampleRate ?? '16k';
  const sampleRate = await probeOutputSampleRate(audioMode);

  const params = new URLSearchParams();
  if (opts.sessionId) params.set('session_id', opts.sessionId);
  if (opts.speaker) params.set('speaker', opts.speaker);
  if (opts.language) params.set('language', opts.language);
  if (opts.mode) params.set('mode', opts.mode);
  params.set('engine', engine);
  params.set('sample_rate', String(sampleRate));

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
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
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
    reconnectTimer = window.setTimeout(connect, delay);
  };

  function connect() {
    if (stopped) return;
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      try {
        capture = await startCapture(
          source,
          (buffer) => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(buffer);
            handlers.onAudioFrame?.(buffer);
          },
          { sampleRateMode: audioMode },
        );
      } catch (err) {
        handlers.onError(err instanceof Error ? err.message : 'Нет доступа к источнику звука');
        cleanup();
      }
    };

    ws.onmessage = (event) => {
      try {
        const evt = JSON.parse(event.data as string);
        if (evt.type === 'transcript') {
          handlers.onTranscript(evt.text, Boolean(evt.is_final), Boolean(evt.speech_final));
        } else if (evt.type === 'utterance_end') {
          handlers.onUtteranceEnd?.(evt.timings as SttTimings | undefined);
        } else if (evt.type === 'low_quality') {
          handlers.onLowQuality?.(evt.text ?? '', evt.reason ?? 'low_quality');
        } else if (evt.type === 'speech_started') {
          handlers.onSpeechStarted?.();
        } else if (evt.type === 'turn_resumed') {
          handlers.onTurnResumed?.();
        } else if (evt.type === 'ready') {
          attempts = 0; // healthy connection — reset the backoff
          handlers.onReady?.({
            engine: evt.engine ?? engine,
            model: evt.model ?? evt.final_model ?? engine,
            partialModel: evt.partial_model,
            finalModel: evt.final_model ?? evt.model,
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

  return { stop: cleanup };
}
