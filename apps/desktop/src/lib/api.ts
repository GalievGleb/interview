import type { AppliedCorrection } from '@interview/shared';
import {
  AiSettings,
  ChatMode,
  NormalizedModel,
} from './aiModels';

const API_URL = (import.meta.env.VITE_API_URL as string) ?? 'http://127.0.0.1:8000';

export interface StreamInterviewCorrectionMeta {
  raw_question?: string;
  glossary_corrected?: string;
  intent_corrected?: string;
  llm_corrected?: string;
  llm_correction_applied?: boolean;
  ambiguity?: string;
  corrections?: AppliedCorrection[];
  intent_corrections?: Array<{ from: string; to: string; reason: string; confidence: string }>;
  intent_confidence?: string;
  intent_reason?: string;
}

export interface StreamInterviewOpts {
  sessionId?: string;
  rawQuestion?: string;
  glossaryCorrected?: string;
  intentCorrected?: string;
  ambiguity?: string;
  corrections?: AppliedCorrection[];
  intentCorrections?: StreamInterviewCorrectionMeta['intent_corrections'];
  intentConfidence?: string;
  intentReason?: string;
  needsLlmCorrection?: boolean;
  onMeta?: (meta: StreamInterviewCorrectionMeta) => void;
  onFirstChunk?: () => void;
}

export interface KeysStatus {
  openai: boolean;
  openrouter: boolean;
  deepgram: boolean;
  default_provider: string;
  default_model: string;
}

export interface DocumentItem {
  id: string;
  kind: string;
  title: string;
  created_at: string;
}

export interface InterviewAnswer {
  id: string;
  short: string;
  spoken: string;
  detailed: string;
  english: string;
  risk: string;
}

export interface SessionItem {
  id: string;
  mode: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface SessionDetail extends SessionItem {
  summary: string | null;
  transcripts: { speaker: string; text: string; ts: string }[];
  answers: {
    id: string;
    question: string;
    short: string;
    spoken: string;
    detailed: string;
    english: string;
    risk: string;
  }[];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  if (!resp.ok) {
    let message = `Ошибка ${resp.status}`;
    try {
      const data = await resp.json();
      message = data?.error?.message ?? message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  apiUrl: API_URL,

  health: () => request<{ status: string; version: string }>('/health'),

  getKeys: () => request<KeysStatus>('/settings/keys'),

  saveKeys: (keys: {
    openai_api_key?: string;
    openrouter_api_key?: string;
    deepgram_api_key?: string;
  }) =>
    request<KeysStatus>('/settings/keys', {
      method: 'POST',
      body: JSON.stringify(keys),
    }),

  testProvider: (provider?: string, model?: string) =>
    request<{ ok: boolean; provider: string; model: string }>('/providers/test', {
      method: 'POST',
      body: JSON.stringify({ provider, model }),
    }),

  listModels: (provider?: string) =>
    request<{ models: string[] }>(
      `/providers/models${provider ? `?provider=${provider}` : ''}`,
    ),

  getAiSettings: () => request<AiSettings>('/settings/ai'),

  saveAiSettings: (settings: Partial<AiSettings>) =>
    request<AiSettings>('/settings/ai', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),

  testOpenRouter: (model?: string) =>
    request<{ ok: boolean; provider: string; model: string }>('/providers/openrouter/test', {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),

  listOpenRouterModels: (useCache = false) =>
    request<{ models: NormalizedModel[] }>(
      `/providers/openrouter/models?use_cache=${useCache}`,
    ),

  listDocuments: () => request<{ documents: DocumentItem[] }>('/documents'),

  uploadText: (kind: string, title: string, text: string) =>
    request<{ id: string; kind: string; title: string; chunks: number }>('/documents/text', {
      method: 'POST',
      body: JSON.stringify({ kind, title, text }),
    }),

  uploadFile: async (kind: string, file: File, title?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('kind', kind);
    if (title) form.append('title', title);
    const resp = await fetch(`${API_URL}/documents/upload`, { method: 'POST', body: form });
    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      throw new Error(data?.error?.message ?? `Ошибка ${resp.status}`);
    }
    return resp.json() as Promise<{ id: string; kind: string; title: string; chunks: number }>;
  },

  deleteDocument: (id: string) =>
    request<{ deleted: string }>(`/documents/${id}`, { method: 'DELETE' }),

  createSession: (mode: 'interview' | 'meeting', title?: string) =>
    request<SessionItem>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ mode, title }),
    }),

  listSessions: () => request<{ sessions: SessionItem[] }>('/sessions'),

  getSession: (id: string) => request<SessionDetail>(`/sessions/${id}`),

  endSession: (id: string, summary?: string) =>
    request<{ id: string; ended_at: string }>(`/sessions/${id}/end`, {
      method: 'POST',
      body: JSON.stringify({ summary }),
    }),

  interview: (
    question: string,
    sessionId?: string,
    opts: { mode?: ChatMode; provider?: string; model?: string; signal?: AbortSignal } = {},
  ) =>
    request<InterviewAnswer>('/chat/interview', {
      method: 'POST',
      body: JSON.stringify({
        question,
        session_id: sessionId,
        mode: opts.mode ?? 'fast',
        provider: opts.provider,
        model: opts.model,
      }),
      signal: opts.signal,
    }),

  meetingSummary: (
    transcript: string,
    opts: { mode?: ChatMode; provider?: string; model?: string } = {},
  ) =>
    request<{ summary: string; model?: string }>('/chat/meeting-summary', {
      method: 'POST',
      body: JSON.stringify({
        transcript,
        mode: opts.mode ?? 'deep',
        provider: opts.provider,
        model: opts.model,
      }),
    }),

  usage: () => request<{ usage: unknown[] }>('/usage'),

  deleteAllData: () => request<{ deleted: boolean }>('/data', { method: 'DELETE' }),

  /** Live-подсказка со стримингом (SSE). Возвращает функцию отмены. */
  streamInterview(
    question: string,
    handlers: {
      onChunk: (text: string) => void;
      onDone: (spoken: string) => void;
      onError: (msg: string) => void;
    },
    opts: StreamInterviewOpts = {},
  ): () => void {
    const controller = new AbortController();
    let spoken = '';
    let finished = false;

    const finish = (text: string) => {
      if (finished) return;
      finished = true;
      handlers.onDone(text);
    };

    void (async () => {
      try {
        const resp = await fetch(`${API_URL}/chat/interview/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: question,
            raw_question: opts.rawQuestion ?? question,
            glossary_corrected: opts.glossaryCorrected ?? question,
            intent_corrected: opts.intentCorrected ?? opts.glossaryCorrected ?? question,
            ambiguity: opts.ambiguity ?? null,
            corrections: opts.corrections ?? [],
            intent_corrections: opts.intentCorrections ?? [],
            intent_confidence: opts.intentConfidence ?? null,
            intent_reason: opts.intentReason ?? null,
            needs_llm_correction: opts.needsLlmCorrection ?? false,
            session_id: opts.sessionId,
            mode: 'fast',
          }),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          let message = `Ошибка ${resp.status}`;
          try {
            const data = await resp.json();
            message = data?.error?.message ?? message;
          } catch {
            // ignore
          }
          if (spoken) finish(spoken);
          else handlers.onError(message);
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const processLine = (line: string): boolean => {
          if (!line.startsWith('data: ')) return false;
          try {
            const evt = JSON.parse(line.slice(6)) as {
              type: string;
              text?: string;
              spoken?: string;
              message?: string;
              correction?: StreamInterviewCorrectionMeta;
            };
            if (evt.type === 'chunk' && evt.text) {
              spoken += evt.text;
              opts.onFirstChunk?.();
              handlers.onChunk(evt.text);
            } else if (evt.type === 'done') {
              if (evt.correction) opts.onMeta?.(evt.correction);
              finish(evt.spoken ?? spoken);
              return true;
            } else if (evt.type === 'error') {
              if (spoken) finish(spoken);
              else handlers.onError(evt.message ?? 'Ошибка');
              return true;
            }
          } catch {
            // ignore
          }
          return false;
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (processLine(line)) return;
            }
          }
          if (done) break;
        }

        buffer += decoder.decode();
        for (const line of buffer.split('\n')) {
          if (processLine(line)) return;
        }
        if (spoken) finish(spoken);
        else handlers.onError('Пустой ответ от модели');
      } catch (err) {
        if (spoken) finish(spoken);
        else if ((err as Error).name !== 'AbortError') {
          handlers.onError(err instanceof Error ? err.message : 'Ошибка запроса');
        }
      }
    })();
    return () => controller.abort();
  },

  /** Стриминговый чат через SSE. Возвращает функцию отмены. */
  streamChat(
    message: string,
    handlers: {
      onChunk: (text: string) => void;
      onDone: () => void;
      onError: (msg: string) => void;
    },
    opts: { mode?: ChatMode; provider?: string; model?: string; context?: string } = {},
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const resp = await fetch(`${API_URL}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            mode: opts.mode ?? 'general',
            context: opts.context,
            provider: opts.provider,
            modelOverride: opts.model,
          }),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          handlers.onError(`Ошибка ${resp.status}`);
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.type === 'chunk') handlers.onChunk(evt.text);
              else if (evt.type === 'done') handlers.onDone();
              else if (evt.type === 'error') handlers.onError(evt.message);
            } catch {
              // ignore
            }
          }
        }
        handlers.onDone();
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          handlers.onError(err instanceof Error ? err.message : 'Ошибка запроса');
        }
      }
    })();
    return () => controller.abort();
  },
};
