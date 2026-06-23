import { api } from './api';
import { startCapture, AudioCapture, AudioSource } from './audioCapture';
import {
  AudioSampleRateMode,
  probeOutputSampleRate,
  SttEngine,
  SttSessionOptions,
} from './sttOptions';

export interface LiveHandlers {
  onTranscript: (text: string, isFinal: boolean, speechFinal: boolean) => void;
  onUtteranceEnd?: () => void;
  onTurnResumed?: () => void;
  onReady?: (info: { engine: string; model: string; sampleRate: number }) => void;
  onError: (message: string) => void;
  onClose?: () => void;
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

  const ws = new WebSocket(`${toWsUrl(api.apiUrl)}/stt/stream?${params.toString()}`);
  ws.binaryType = 'arraybuffer';

  let capture: AudioCapture | null = null;
  let stopped = false;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    capture?.stop();
    capture = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };

  ws.onopen = async () => {
    try {
      capture = await startCapture(source, (buffer) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(buffer);
      }, { sampleRateMode: audioMode });
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
        handlers.onUtteranceEnd?.();
      } else if (evt.type === 'turn_resumed') {
        handlers.onTurnResumed?.();
      } else if (evt.type === 'ready') {
        handlers.onReady?.({
          engine: evt.engine ?? engine,
          model: evt.model ?? engine,
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

  ws.onerror = () => {
    if (!stopped) handlers.onError('Ошибка WebSocket — проверьте, что backend запущен');
  };

  ws.onclose = () => {
    capture?.stop();
    capture = null;
    if (!stopped) handlers.onClose?.();
  };

  return { stop: cleanup };
}
