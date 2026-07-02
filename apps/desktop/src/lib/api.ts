import type { AppliedCorrection, SttProviderDiagnostics } from '@interview/shared';
import {
  AiSettings,
  ChatMode,
  NormalizedModel,
} from './aiModels';

export type WhisperQualityId = 'fast' | 'balanced' | 'quality' | 'max';
export type SttDeviceId = 'auto' | 'cpu' | 'gpu';

export interface SttModelStatus {
  quality: WhisperQualityId;
  modelId: string;
  status: 'idle' | 'downloading' | 'ready' | 'error';
  downloaded: boolean;
  progress: number;
  onDiskMb: number;
  approxDownloadMb: number;
  error: string | null;
}

export interface SttDeviceInfo {
  totalRamGb: number | null;
  cpuCount: number | null;
  hasGpu: boolean;
  recommendedQuality: WhisperQualityId;
  recommendedDevice: 'cpu' | 'gpu';
}

export interface SttSettingsDto {
  local_model: WhisperQualityId;
  partial_model: WhisperQualityId;
  final_model: WhisperQualityId;
  device: SttDeviceId;
}

export interface SttDiagnostics {
  provider: string;
  localModel: WhisperQualityId;
  model: string | null;
  device: string | null;
  available: boolean;
  reason: string;
  lastError: string | null;
  privacyDescription: string;
  resourceUsage: string;
  avgBenchmarkLatencyMs: number | null;
  lastBenchmarkAt: string | null;
}

export interface SttBenchmarkKeyword {
  key: string;
  aliases: string[];
}

export interface SttBenchmarkCase {
  id: string;
  title: string;
  audioFile: string;
  transcriptKeywords: SttBenchmarkKeyword[];
  expectedTerms: string[];
}

export interface SttBenchmarkCaseResult {
  caseId: string;
  title?: string;
  raw?: { transcript: string; latencyMs: number; keywordMatch: number; semanticMatch?: number };
  corrected?: {
    transcript: string;
    keywordMatch: number;
    semanticMatch?: number;
    corrections: Array<{ from: string; to: string }>;
    correctionActive?: boolean;
    keywordsHit?: string[];
    keywordsMissed?: string[];
    meaningHit?: string[];
    meaningMissed?: string[];
  };
  keywordGain?: number;
  semanticGain?: number;
  intentMatch?: number;
  falseNegative?: boolean;
  errorType: string;
  engine?: string;
  model?: string;
  error?: string;
}

export interface SttBenchmarkReport {
  generatedAt: string;
  engine: string;
  model: string;
  caseCount: number;
  avgLatencyMs: number;
  avgKeywordMatchRaw: number;
  avgKeywordMatchCorrected: number;
  correctionGain: number;
  avgSemanticMatchRaw?: number;
  avgSemanticMatchCorrected?: number;
  semanticCorrectionGain?: number;
  avgIntentMatch: number;
  casesWithCorrections?: number;
  correctionInactive?: number;
  falseNegatives?: number;
  errorTypes: Record<string, number>;
  cases: SttBenchmarkCaseResult[];
  savedAs?: string;
}

const API_URL = (import.meta.env.VITE_API_URL as string) ?? 'http://127.0.0.1:8000';

const FAST_ANSWER_KEY = 'fast-answer';
/** Fast answer mode (default on): skip the serial LLM correction + throughput routing. */
export function getFastAnswer(): boolean {
  return localStorage.getItem(FAST_ANSWER_KEY) !== '0';
}
export function setFastAnswer(on: boolean): void {
  localStorage.setItem(FAST_ANSWER_KEY, on ? '1' : '0');
}
const REQUEST_TIMEOUT_MS = 10_000;
const LONG_REQUEST_TIMEOUT_MS = 180_000;

export interface UsageRow {
  provider: string;
  kind: string;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  stt_seconds: number;
}

interface SseHandlers {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

/** Generic SSE POST stream for chat endpoints. Returns a cancel function. */
function sseChatStream(path: string, body: unknown, handlers: SseHandlers): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const resp = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
}

type RequestOptions = RequestInit & { timeoutMs?: number };

async function fetchWithTimeout(path: string, options: RequestOptions = {}): Promise<Response> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, signal: userSignal, ...rest } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (userSignal) {
    userSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    return await fetch(`${API_URL}${path}`, { ...rest, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        timeoutMs <= REQUEST_TIMEOUT_MS
          ? 'Бэкенд не отвечает — проверьте, что uvicorn запущен на порту 8000'
          : 'Операция заняла слишком много времени — попробуйте ещё раз',
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

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
  question_intent?: string;
  answer_strategy?: string;
  resume_context_used?: boolean;
  resume_context_level?: string;
  resume_context_reason?: string;
  suggest_unclear_prefix?: boolean;
  resolved_follow_up_question?: string;
  previous_topic?: string;
  used_previous_context?: boolean;
  is_follow_up?: boolean;
  follow_up_reason?: string;
  current_canonical_topic?: string;
  // Python Knowledge Pack metrics (server-reported).
  knowledgePackUsed?: boolean;
  knowledgePackName?: string | null;
  knowledgeSource?: string;
  retrievedItemsCount?: number;
  injectedContextTokens?: number;
  knowledgeRetrievalMs?: number;
  answerLatencyWithKnowledgeMs?: number;
}

export interface StreamInterviewOpts {
  sessionId?: string;
  rawQuestion?: string;
  glossaryCorrected?: string;
  intentCorrected?: string;
  resolvedQuestion?: string;
  previousTopic?: string;
  isFollowUp?: boolean;
  usedPreviousContext?: boolean;
  followUpReason?: string;
  currentCanonicalTopic?: string;
  ambiguity?: string;
  corrections?: AppliedCorrection[];
  intentCorrections?: StreamInterviewCorrectionMeta['intent_corrections'];
  intentConfidence?: string;
  intentReason?: string;
  needsLlmCorrection?: boolean;
  questionIntent?: string;
  answerStrategy?: string;
  resumeContextUsed?: boolean;
  resumeContextLevel?: string;
  resumeContextReason?: string;
  suggestUnclearPrefix?: boolean;
  onMeta?: (meta: StreamInterviewCorrectionMeta) => void;
  onFirstChunk?: () => void;
  fastAnswer?: boolean;
}

export interface KeysStatus {
  openai: boolean;
  openrouter: boolean;
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

export type AnswerVariantKind = 'short' | 'detailed' | 'english' | 'risk';

export interface SessionItem {
  id: string;
  mode: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  answer_count?: number;
  transcript_count?: number;
}

export interface SessionStats {
  interview_sessions: number;
  meeting_sessions: number;
  total_answers: number;
  avg_answers_per_session: number;
  last_session_at: string | null;
  top_topics: Array<{ topic: string; count: number }>;
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

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs, ...fetchOptions } = options;
  const resp = await fetchWithTimeout(path, {
    headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers ?? {}) },
    timeoutMs,
    ...fetchOptions,
  });
  if (!resp.ok) {
    let message = `Ошибка ${resp.status}`;
    try {
      const data = await resp.json();
      message = data?.error?.message ?? (typeof data?.detail === 'string' ? data.detail : message);
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

  getDocument: (id: string) =>
    request<{ id: string; kind: string; title: string; text: string }>(
      `/documents/${encodeURIComponent(id)}`,
    ),

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

  /** Агрегаты по истории для дашборда на главной. */
  sessionStats: () => request<SessionStats>('/sessions/stats'),

  getSession: (id: string) => request<SessionDetail>(`/sessions/${id}`),

  deleteSession: async (id: string) => {
    try {
      return await request<{ deleted: string }>(`/sessions/${id}`, { method: 'DELETE' });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (!message.includes('405')) throw err;
      return request<{ deleted: string }>(`/sessions/${id}/delete`, { method: 'POST' });
    }
  },

  deleteAllSessions: async () => {
    try {
      return await request<{ deleted: number }>('/sessions', { method: 'DELETE' });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (!message.includes('405')) throw err;
      return request<{ deleted: number }>('/sessions/delete-all', { method: 'POST' });
    }
  },

  endSession: (id: string, summary?: string) =>
    request<{ id: string; ended_at: string }>(`/sessions/${id}/end`, {
      method: 'POST',
      body: JSON.stringify({ summary }),
    }),

  /** Сохранить финальную строку транскрипта в сессию (для пост-разбора в Истории). */
  addTranscript: (sessionId: string, speaker: 'me' | 'other', text: string) =>
    request<{ id: string }>(`/sessions/${sessionId}/transcript`, {
      method: 'POST',
      body: JSON.stringify({ speaker, text, is_final: true }),
    }),

  /** Ленивая генерация варианта ответа для табов «Кратко/Подробно/Английский/Риски».
   *  С answerId вариант кэшируется в БД — при повторном заходе LLM не вызывается. */
  answerVariant: (question: string, answer: string, variant: AnswerVariantKind, answerId?: string) =>
    request<{ text: string; model?: string; variant: string; cached?: boolean }>(
      '/chat/answer-variant',
      {
        method: 'POST',
        timeoutMs: LONG_REQUEST_TIMEOUT_MS,
        body: JSON.stringify({ question, answer, variant, answer_id: answerId ?? null }),
      },
    ),

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
      timeoutMs: LONG_REQUEST_TIMEOUT_MS, // a full completion can exceed the 10s default
      body: JSON.stringify({
        transcript,
        mode: opts.mode ?? 'deep',
        provider: opts.provider,
        model: opts.model,
      }),
    }),

  /** Analyze an uploaded interview transcript — surfaces the candidate's weak answers. */
  interviewReview: (
    transcript: string,
    opts: { mode?: ChatMode; provider?: string; model?: string } = {},
  ) =>
    request<{ review: string; model?: string }>('/chat/interview-review', {
      method: 'POST',
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
      body: JSON.stringify({
        transcript,
        mode: opts.mode ?? 'deep',
        provider: opts.provider,
        model: opts.model,
      }),
    }),

  usage: () => request<{ usage: UsageRow[]; last_30_days?: UsageRow[] }>('/usage'),

  deleteAllData: () => request<{ deleted: boolean }>('/data', { method: 'DELETE' }),

  /** Live-подсказка со стримингом (SSE). Возвращает функцию отмены. */
  streamInterview(
    question: string,
    handlers: {
      onChunk: (text: string) => void;
      onDone: (spoken: string, answerId?: string) => void;
      onError: (msg: string) => void;
    },
    opts: StreamInterviewOpts = {},
  ): () => void {
    const controller = new AbortController();
    let spoken = '';
    let finished = false;

    const finish = (text: string, answerId?: string) => {
      if (finished) return;
      finished = true;
      handlers.onDone(text, answerId);
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
            question_intent: opts.questionIntent ?? null,
            answer_strategy: opts.answerStrategy ?? null,
            resume_context_used: opts.resumeContextUsed ?? null,
            resume_context_level: opts.resumeContextLevel ?? null,
            resume_context_reason: opts.resumeContextReason ?? null,
            suggest_unclear_prefix: opts.suggestUnclearPrefix ?? null,
            resolved_follow_up_question: opts.resolvedQuestion ?? null,
            previous_topic: opts.previousTopic ?? null,
            used_previous_context: opts.usedPreviousContext ?? null,
            is_follow_up: opts.isFollowUp ?? null,
            follow_up_reason: opts.followUpReason ?? null,
            current_canonical_topic: opts.currentCanonicalTopic ?? null,
            session_id: opts.sessionId,
            mode: 'fast',
            // Fast answer: skip the serial LLM correction pass + throughput
            // routing. Default on; toggled via localStorage('fast-answer').
            fast_answer: opts.fastAnswer ?? getFastAnswer(),
          }),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          let message = `Ошибка ${resp.status}`;
          try {
            const data = await resp.json();
            message = data?.error?.message ?? (typeof data?.detail === 'string' ? data.detail : message);
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
              id?: string;
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
              finish(evt.spoken ?? spoken, evt.id);
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

  /** Streaming interview review (SSE). Returns a cancel function. */
  streamInterviewReview(
    transcript: string,
    handlers: SseHandlers,
    opts: { provider?: string; model?: string } = {},
  ): () => void {
    return sseChatStream(
      '/chat/interview-review/stream',
      { transcript, mode: 'deep', provider: opts.provider, model: opts.model },
      handlers,
    );
  },

  /** Streaming meeting summary (SSE). Returns a cancel function. */
  streamMeetingSummary(
    transcript: string,
    handlers: SseHandlers,
    opts: { provider?: string; model?: string } = {},
  ): () => void {
    return sseChatStream(
      '/chat/meeting-summary/stream',
      { transcript, mode: 'deep', provider: opts.provider, model: opts.model },
      handlers,
    );
  },

  /** Vacancy Smoke Review — LLM analysis (desktop falls back to a local mock). */
  vacancyAnalyze: (body: {
    vacancyText: string;
    targetRole?: string;
    language: string;
    resumeText?: string;
    legendText?: string;
  }) =>
    request<{
      targetRole: string;
      seniorityLevel: string;
      extractedRequirements: string[];
      optionalSkills: string[];
      competencies?: Array<{
        name: string;
        priority: string;
        expectedLevel: string;
        resumeMatch: string;
        note: string;
      }>;
      interviewTopics: Array<{
        id: string;
        title: string;
        category: string;
        importance: string;
        level?: string;
        expectedKnowledge: string;
        sampleQuestions: string[];
        whyAsked?: string;
        expectedAnswerPoints?: string[];
        relatedVacancyTopics?: string[];
        relatedResumeEvidence?: string[];
        vacancyEvidence: string;
      }>;
      projectQuestions: string[];
      riskAreas: string[];
    }>('/vacancy/analyze', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    }),

  vacancyEvaluate: (body: {
    question: string;
    answer: string;
    topic?: string;
    level?: string;
    expectedSignals?: string[];
    relatedResumeEvidence?: string[];
    resumeText?: string;
    vacancyText?: string;
    legendText?: string;
    language: string;
    hasResume: boolean;
  }) =>
    request<{
      score: number;
      coverageScore?: number;
      technicalContentScore?: number;
      projectSpecificityScore?: number;
      leadershipScore?: number;
      ownershipScore?: number;
      structureScore?: number;
      speechClarityScore?: number;
      clarityScore: number;
      technicalAccuracyScore: number;
      specificityScore: number;
      confidenceScore: number;
      levelEstimate?: string;
      verdict?: string;
      feedback: string;
      normalizedAnswerSummary?: string;
      detectedNoiseOrAsrErrors?: string[];
      extractedValidPoints?: string[];
      goodPoints: string[];
      weakPoints?: string[];
      missingPoints: string[];
      technicalCorrections?: string[];
      hallucinationGuard?: string[];
      betterStructure?: string[];
      suggestedBetterAnswer: string;
      followUpQuestions?: string[];
      nextTrainingFocus?: string;
      overclaimed: boolean;
    }>('/vacancy/evaluate', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    }),

  // --- Speech-to-text (Local Whisper provider, model manager) ---
  sttProviders: () => request<SttProviderDiagnostics>('/stt/providers'),

  /** Pre-load + warm the live STT models so the first utterance isn't slow. */
  sttWarmup: () =>
    request<{ warmed: Record<string, string>; ms: number }>('/stt/warmup', {
      method: 'POST',
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    }),

  sttDevice: () => request<SttDeviceInfo>('/stt/device'),

  sttDiagnostics: () => request<SttDiagnostics>('/stt/diagnostics'),

  sttModelStatus: (quality: WhisperQualityId) =>
    request<SttModelStatus>(`/stt/models/${quality}/status`),

  sttModelDownload: (quality: WhisperQualityId) =>
    request<SttModelStatus>(`/stt/models/${quality}/download`, { method: 'POST' }),

  sttModelDelete: (quality: WhisperQualityId) =>
    request<{ quality: string; deleted: boolean }>(`/stt/models/${quality}`, {
      method: 'DELETE',
    }),

  getSttSettings: () => request<SttSettingsDto>('/stt/settings'),

  saveSttSettings: (settings: Partial<SttSettingsDto>) =>
    request<SttSettingsDto>('/stt/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),

  // --- STT Benchmark (audio -> transcript only, no LLM) ---
  sttBenchmarkCases: () =>
    request<{ cases: SttBenchmarkCase[]; root: string }>('/stt/benchmark/cases'),

  sttBenchmarkRunCase: (caseId: string) =>
    request<SttBenchmarkCaseResult>(`/stt/benchmark/run/${encodeURIComponent(caseId)}`, {
      method: 'POST',
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    }),

  sttBenchmarkRunAll: (save = true) =>
    request<SttBenchmarkReport>('/stt/benchmark/run', {
      method: 'POST',
      body: JSON.stringify({ save }),
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    }),

  sttBenchmarkReports: () =>
    request<{ reports: Array<{ filename: string; modifiedAt: string }> }>('/stt/benchmark/reports'),

  sttBenchmarkReport: (filename: string) =>
    request<SttBenchmarkReport>(`/stt/benchmark/reports/${encodeURIComponent(filename)}`),

  voiceTestCases: () =>
    request<{ cases: unknown[]; root: string; audioDir: string }>('/voice-tests/cases'),

  voiceTestTranscribe: (caseId: string) =>
    request<{
      caseId: string;
      transcript: string;
      sttLatencyMs: number;
      timings?: {
        modelLoadMs: number;
        whisperInferenceMs: number;
        audioBytes: number;
        modelReused: boolean;
      };
      audioPath: string;
    }>(
      `/voice-tests/transcribe/${encodeURIComponent(caseId)}`,
      { method: 'POST', timeoutMs: LONG_REQUEST_TIMEOUT_MS },
    ),

  voiceTestSaveReport: (report: unknown, filename?: string) =>
    request<{ path: string; filename: string }>('/voice-tests/reports', {
      method: 'POST',
      body: JSON.stringify({ report, filename }),
    }),

  voiceTestListReports: () =>
    request<{ reports: Array<{ filename: string; path: string; modifiedAt: string }> }>(
      '/voice-tests/reports',
    ),

  voiceTestGetReport: (filename: string) =>
    request<Record<string, unknown>>(`/voice-tests/reports/${encodeURIComponent(filename)}`),
};
