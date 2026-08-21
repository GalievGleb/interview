import type { SttProviderDiagnostics } from '@interview/shared';
import {
  AiSettings,
  ChatMode,
  NormalizedModel,
} from './aiModels';
import { answerLanguageParam } from './answerLanguage';
import type { DebugBundle } from './liveDebugRecorder';
import { parseInterviewStreamEvent } from './streamInterviewEvent';

export interface SttSettingsDto {
  engine: 'openai-mini';
  model: 'gpt-4o-mini-transcribe';
}

export interface SttDiagnostics {
  provider: string;
  engine: string;
  model: string;
  available: boolean;
  reason: string;
  lastError: string | null;
  privacyDescription: string;
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
  raw?: {
    transcript: string;
    latencyMs: number;
    keywordMatch: number;
    semanticMatch?: number;
    keywordsHit?: string[];
    keywordsMissed?: string[];
    meaningHit?: string[];
    meaningMissed?: string[];
  };
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
  avgSemanticMatchRaw?: number;
  avgIntentMatch: number;
  falseNegatives?: number;
  errorTypes: Record<string, number>;
  cases: SttBenchmarkCaseResult[];
  savedAs?: string;
}

const API_URL =
  (import.meta.env.VITE_API_URL as string) ??
  'http://127.0.0.1:8000';

// Локальная аутентификация: Electron выдаёт per-run токен, бэкенд без него
// отвечает 401 (защита от чужих локальных процессов и drive-by запросов).
let apiTokenPromise: Promise<string> | null = null;
export function getApiToken(): Promise<string> {
  if (!apiTokenPromise) {
    apiTokenPromise = window.electronAPI?.getApiToken?.().catch(() => '') ?? Promise.resolve('');
  }
  return apiTokenPromise;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getApiToken();
  return token ? { 'X-SkillCue-Token': token } : {};
}

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
// Сторож простоя SSE-стримов: столько тишины (без единого байта) = мёртвый поток.
// Первый токен обычно приходит за 1–3 с; 25 с покрывает медленную модель, но
// ловит зависший сервер/сеть до того, как суфлёр «застрянет» на всю сессию.
const STREAM_IDLE_TIMEOUT_MS = 25_000;
// Оценка ответа — тяжёлый структурный LLM-вызов (резюме+вакансия+ответ+рубрика →
// детальный разбор с баллами). 15 с было слишком жёстко: медленная модель или
// секунда лага провайдера роняли КАЖДУЮ оценку в локальный фолбэк. Это не live-
// путь, пользователь готов подождать пару секунд ради настоящего разбора.
// The API uses a compact non-reasoning model with a 4.5s budget. This client
// guard guarantees an immediate local fallback if transport cancellation stalls.
const VACANCY_EVALUATE_TIMEOUT_MS = 5_000;

export interface MockAnswerTranscriptionContext {
  question: string;
  hints: string[];
  language: string;
}

export function createMockAnswerTranscriptionForm(
  wav: Blob,
  context: MockAnswerTranscriptionContext,
): FormData {
  const form = new FormData();
  form.append('file', wav, 'answer.wav');
  form.append('question', context.question);
  form.append('hints', JSON.stringify(context.hints));
  form.append('language', context.language);
  return form;
}

export interface LicenseStatusDto {
  status: 'trial' | 'active' | 'expired';
  plan: 'trial' | 'basic' | 'max';
  licensed_to: string | null;
  live_allowed: boolean;
  /** null для активной лицензии; для trial — остаток live-секунд. */
  live_seconds_left: number | null;
  tokens_used_month: number;
  tokens_budget_month: number;
  tokens_left_month: number;
}

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

/**
 * Сторож простоя для SSE-стримов: если поток замолчал (сервер завис / сеть
 * встала без разрыва TCP), reader.read() висел бы вечно, а вызвавший код держал
 * бы busy-флаг навсегда. Таймер перевзводится на каждый пришедший байт;
 * срабатывание = abort зависшего чтения. `state.timedOut` отличает это от
 * пользовательской отмены (которая тоже даёт AbortError).
 */
export function createIdleWatchdog(controller: AbortController): {
  state: { timedOut: boolean };
  arm: () => void;
  disarm: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const state = { timedOut: false };
  return {
    state,
    arm() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        state.timedOut = true;
        controller.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    },
    disarm() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Generic SSE POST stream for chat endpoints. Returns a cancel function. */
function sseChatStream(path: string, body: unknown, handlers: SseHandlers): () => void {
  const controller = new AbortController();
  const watchdog = createIdleWatchdog(controller);
  void (async () => {
    try {
      watchdog.arm();
      const resp = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
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
        watchdog.arm();
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
      if (watchdog.state.timedOut) {
        handlers.onError('Ответ не пришёл вовремя — соединение зависло. Повторите.');
      } else if ((err as Error).name !== 'AbortError') {
        handlers.onError(err instanceof Error ? err.message : 'Ошибка запроса');
      }
    } finally {
      watchdog.disarm();
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
          ? 'SkillCue не ответил вовремя. Повторите действие через пару секунд.'
          : 'Операция заняла слишком много времени — попробуйте ещё раз',
        { cause: err },
      );
    }
    // `fetch` бросает TypeError при сетевом сбое (соединение отклонено). Обычно
    // это первые секунды после старта, пока бэкенд ещё поднимается — показываем
    // человекочитаемую причину вместо сырого «Failed to fetch».
    if (err instanceof TypeError) {
      throw new Error(
        'SkillCue сейчас не готов принять запрос. Повторите действие через пару секунд; если повторяется — перезапустите приложение.',
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
  resolvedQuestion?: string;
  previousTopic?: string;
  isFollowUp?: boolean;
  usedPreviousContext?: boolean;
  followUpReason?: string;
  currentCanonicalTopic?: string;
  questionIntent?: string;
  answerStrategy?: string;
  resumeContextUsed?: boolean;
  resumeContextLevel?: string;
  resumeContextReason?: string;
  suggestUnclearPrefix?: boolean;
  onMeta?: (meta: StreamInterviewCorrectionMeta) => void;
  onFirstChunk?: () => void;
  fastAnswer?: boolean;
  /** Слабые темы из mock-отчёта — ответы на них делаются особенно конкретными. */
  weakTopics?: string[];
}

export interface KeysStatus {
  openai: boolean;
  openrouter: boolean;
  managed_openrouter?: boolean;
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

export interface InterviewOutcomeResult {
  headline: string;
  facts: string[];
  conditions: string[];
  nextSteps: string[];
  openQuestions: string[];
  model?: string;
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
    model?: string | null;
    ts?: string;
  }[];
  diagnostics?: DebugBundle | null;
}

export interface SessionKnowledgeTopicDto {
  topic: string;
  score: number;
  confidence: number;
  evidenceCount: number;
}

export interface SessionKnowledgeDto {
  weakTopics: SessionKnowledgeTopicDto[];
  strongTopics: SessionKnowledgeTopicDto[];
  updatedAt: string;
}

export interface SessionAssessment {
  analysisVersion?: 2;
  sourceFingerprint?: string;
  analysisLanguage?: 'ru' | 'en';
  interviewType: 'technical' | 'hr' | 'mixed' | 'unknown';
  overallLevel: string;
  overallScore: number;
  overallConfidence: number;
  conclusion: string;
  strengths: Array<{ topic: string; evidence: string }>;
  weaknesses: Array<{ topic: string; evidence: string; learningAction: string }>;
  topicAssessments: Array<{ topic: string; score: number; confidence: number }>;
  answerReviews?: Array<{
    question: string;
    candidateAnswer: string;
    topic: string;
    score: number;
    confidence: number;
    whatWasGood: string[];
    problems: string[];
    missingPoints: string[];
    betterAnswer: string;
  }>;
  markdown: string;
}

export interface DevelopmentProfileTopic {
  topic: string;
  score: number;
  confidence: number;
  evidenceCount: number;
  learningAction: string | null;
}

export interface DevelopmentProfileTrack {
  level: string | null;
  score: number | null;
  confidence: number;
  evidenceCount: number;
  strengths: DevelopmentProfileTopic[];
  focusAreas: DevelopmentProfileTopic[];
}

export interface DevelopmentProfile {
  analyzedSessions: number;
  technical: DevelopmentProfileTrack;
  hr: DevelopmentProfileTrack;
  recentSessions: Array<{
    sessionId: string;
    title: string | null;
    startedAt: string;
    interviewType: 'technical' | 'hr' | 'mixed' | 'unknown';
    overallLevel: string | null;
    score: number;
    confidence: number;
  }>;
  recentAnswers: Array<{
    sessionId: string;
    title: string | null;
    startedAt: string;
    interviewType: 'technical' | 'hr' | 'mixed' | 'unknown';
    question: string;
    candidateAnswer: string;
    topic: string;
    score: number;
    confidence: number;
    problems: string[];
    missingPoints: string[];
    betterAnswer: string;
  }>;
  updatedAt: string;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs, ...fetchOptions } = options;
  const resp = await fetchWithTimeout(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeaders()),
      ...(fetchOptions.headers ?? {}),
    },
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

  synthesizeSpeech: async (input: string, language: 'ru' | 'en'): Promise<Blob> => {
    const resp = await fetchWithTimeout('/tts/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ input, language }),
      timeoutMs: 30_000,
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      throw new Error(data?.error?.message ?? `Ошибка озвучки ${resp.status}`);
    }
    return resp.blob();
  },

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

  providerReadiness: (model?: string) =>
    request<{
      ok: boolean;
      model: string;
      latency_ms: number;
      answer: string;
      matched_concepts: string[];
      question: string;
    }>('/providers/readiness', {
      method: 'POST',
      timeoutMs: 30_000,
      body: JSON.stringify({ model }),
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
    const resp = await fetch(`${API_URL}/documents/upload`, {
      method: 'POST',
      headers: await authHeaders(),
      body: form,
    });
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

  getKnowledgeMap: () => request<SessionKnowledgeDto>('/sessions/knowledge-map'),

  getDevelopmentProfile: () =>
    request<DevelopmentProfile>('/sessions/development-profile'),

  createSessionAnalysis: (id: string, language: 'ru' | 'en', force = false) =>
    request<SessionAssessment>(`/sessions/${encodeURIComponent(id)}/analysis`, {
      method: 'POST',
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
      body: JSON.stringify({ language, force }),
    }),

  getSessionAnalysis: (id: string) =>
    request<SessionAssessment>(`/sessions/${encodeURIComponent(id)}/analysis`),

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

  saveSessionDiagnostics: (sessionId: string, diagnostics: DebugBundle) =>
    request<{ saved: string; event_count: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/diagnostics`,
      {
        method: 'PUT',
        body: JSON.stringify(diagnostics),
      },
    ),

  /** Ленивая генерация варианта ответа для табов «Кратко/Подробно/Английский/Риски».
   *  С answerId вариант кэшируется в БД — при повторном заходе LLM не вызывается. */
  answerVariant: (question: string, answer: string, variant: AnswerVariantKind, answerId?: string) =>
    request<{ text: string; model?: string; variant: string; cached?: boolean }>(
      '/chat/answer-variant',
      {
        method: 'POST',
        timeoutMs: LONG_REQUEST_TIMEOUT_MS,
        body: JSON.stringify({
          question,
          answer,
          variant,
          answer_id: answerId ?? null,
          answer_language: answerLanguageParam(),
        }),
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
        answer_language: answerLanguageParam(),
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
        answer_language: answerLanguageParam(),
      }),
    }),

  interviewOutcome: (input: {
    transcript: string;
    interviewType: 'hr' | 'technical' | 'other';
    vacancyTitle: string;
    companyName: string;
    answerLanguage?: 'ru' | 'en';
  }) =>
    request<InterviewOutcomeResult>('/chat/interview-outcome', {
      method: 'POST',
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
      body: JSON.stringify({
        transcript: input.transcript,
        interview_type: input.interviewType,
        vacancy_title: input.vacancyTitle,
        company_name: input.companyName,
        answer_language: input.answerLanguage ?? answerLanguageParam(),
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
        answer_language: answerLanguageParam(),
      }),
    }),

  usage: () => request<{ usage: UsageRow[]; last_30_days?: UsageRow[] }>('/usage'),

  // --- License (15-мин live-trial / тарифы / токен-бюджет) ---
  licenseStatus: () => request<LicenseStatusDto>('/license/status'),

  activateLicense: (key: string) =>
    request<LicenseStatusDto>('/license/activate', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),

  // --- Answer feedback (👍/👎 → quality tuning material) ---
  recordFeedback: (f: {
    verdict: 'up' | 'down';
    question?: string;
    answer?: string;
    raw_transcript?: string | null;
    source?: 'live' | 'manual';
  }) => request<{ recorded: string }>('/feedback', { method: 'POST', body: JSON.stringify(f) }),

  // --- Latency telemetry (p50/p95 trend vs budgets) ---
  recordLatency: (t: {
    stt_ms: number | null;
    llm_first_ms: number | null;
    llm_total_ms: number | null;
    total_ms: number | null;
  }) => request<{ recorded: string }>('/latency', { method: 'POST', body: JSON.stringify(t) }),

  latencySummary: () =>
    request<{
      count: number;
      budgets_ms: Record<string, number>;
      stages: Record<
        string,
        { p50: number; p95: number; n: number; budget: number | null; within_budget: boolean | null } | null
      >;
    }>('/latency/summary'),

  // --- Mock-interview (Vacancy Review) durable session store ---
  listMockSessions: () =>
    request<{
      sessions: Array<{
        id: string;
        status: string;
        startedAt: number;
        updatedAt: number;
        payload: Record<string, unknown>;
      }>;
    }>('/mock-sessions'),

  upsertMockSession: (s: {
    id: string;
    status: string;
    startedAt: number;
    updatedAt: number;
    payload: Record<string, unknown>;
  }) =>
    request<{ saved: string }>(`/mock-sessions/${encodeURIComponent(s.id)}`, {
      method: 'PUT',
      body: JSON.stringify(s),
    }),

  deleteMockSessionRemote: (id: string) =>
    request<{ deleted: string }>(`/mock-sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  deleteAllData: () => request<{ deleted: boolean }>('/data', { method: 'DELETE' }),

  /** Live-подсказка со стримингом (SSE). Возвращает функцию отмены. */
  streamInterview(
    question: string,
    handlers: {
      onChunk: (text: string) => void;
      onDone: (
        spoken: string,
        answerId?: string,
        meta?: { model?: string; modelSource?: string },
      ) => void;
      onError: (msg: string) => void;
    },
    opts: StreamInterviewOpts = {},
  ): () => void {
    const controller = new AbortController();
    let spoken = '';
    let finished = false;
    // Сторож простоя: без него зависший поток (сервер завис / сеть «чёрная дыра»)
    // держал бы streamLock в useLiveCopilot навсегда true — суфлёр молча умирал
    // бы до конца сессии, без ошибки пользователю.
    const watchdog = createIdleWatchdog(controller);
    const { arm: armIdle, disarm: disarmIdle } = watchdog;

    const finish = (
      text: string,
      answerId?: string,
      meta?: { model?: string; modelSource?: string },
    ) => {
      if (finished) return;
      finished = true;
      disarmIdle();
      handlers.onDone(text, answerId, meta);
    };

    void (async () => {
      try {
        armIdle();
        const resp = await fetch(`${API_URL}/chat/interview/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
          body: JSON.stringify({
            question: question,
            raw_question: opts.rawQuestion ?? question,
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
            weak_topics: opts.weakTopics?.length ? opts.weakTopics : null,
            session_id: opts.sessionId,
            answer_language: answerLanguageParam(),
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
            const evt = parseInterviewStreamEvent(line.slice(6));
            if (!evt) return false;
            if (evt.type === 'chunk' && evt.text) {
              spoken += evt.text;
              opts.onFirstChunk?.();
              handlers.onChunk(evt.text);
            } else if (evt.type === 'done') {
              if (evt.correction) opts.onMeta?.(evt.correction);
              finish(evt.spoken ?? spoken, evt.id, {
                model: evt.model,
                modelSource: evt.modelSource,
              });
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
          armIdle(); // пришли данные (или закрытие) — перевзводим сторож
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
        disarmIdle();
        if (spoken) finish(spoken);
        else if (watchdog.state.timedOut) {
          // Idle-abort, а не пользовательская отмена: обязаны сообщить об ошибке,
          // иначе streamLock в useLiveCopilot останется навсегда взведён.
          handlers.onError('Ответ не пришёл вовремя — соединение зависло. Повторите вопрос.');
        } else if ((err as Error).name !== 'AbortError') {
          handlers.onError(err instanceof Error ? err.message : 'Ошибка запроса');
        }
      } finally {
        disarmIdle();
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
    const watchdog = createIdleWatchdog(controller);
    void (async () => {
      try {
        watchdog.arm();
        const resp = await fetch(`${API_URL}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
          body: JSON.stringify({
            message,
            mode: opts.mode ?? 'general',
            context: opts.context,
            provider: opts.provider,
            modelOverride: opts.model,
            answer_language: answerLanguageParam(),
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
          watchdog.arm();
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
        if (watchdog.state.timedOut) {
          handlers.onError('Ответ не пришёл вовремя — соединение зависло. Повторите.');
        } else if ((err as Error).name !== 'AbortError') {
          handlers.onError(err instanceof Error ? err.message : 'Ошибка запроса');
        }
      } finally {
        watchdog.disarm();
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
      {
        transcript,
        mode: 'deep',
        provider: opts.provider,
        model: opts.model,
        answer_language: answerLanguageParam(),
      },
      handlers,
    );
  },

  /** Vision-подсказка по скриншоту экрана (SSE). Returns a cancel function. */
  streamScreenAssist(
    image: string,
    question: string,
    handlers: SseHandlers,
    opts: { context?: string; mode?: string } = {},
  ): () => void {
    return sseChatStream(
      '/chat/screen/stream',
      {
        image,
        question,
        context: opts.context,
        mode: opts.mode ?? 'general',
        answer_language: answerLanguageParam(),
      },
      handlers,
    );
  },

  /** Streaming meeting summary (SSE). Returns a cancel function. */
  streamMeetingSummary(
    transcript: string,
    handlers: SseHandlers,
    opts: { provider?: string; model?: string; answerLanguage?: 'ru' | 'en' } = {},
  ): () => void {
    return sseChatStream(
      '/chat/meeting-summary/stream',
      {
        transcript,
        mode: 'deep',
        provider: opts.provider,
        model: opts.model,
        answer_language: opts.answerLanguage ?? answerLanguageParam(),
      },
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
      answerStrategy?: string;
      whyThisAnswerWorks?: string[];
      deliveryTips?: string[];
      suggestedBetterAnswer: string;
      followUpQuestions?: string[];
      nextTrainingFocus?: string;
      overclaimed: boolean;
    }>('/vacancy/evaluate', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: VACANCY_EVALUATE_TIMEOUT_MS,
    }),

  vacancyReport: (body: {
    targetRole?: string;
    seniorityLevel?: string;
    overallScore: number;
    topics: Array<{ title: string; score: number; status?: string; missingPoints?: string[] }>;
    weakAnswers?: Array<{ question: string; missing?: string[]; score?: number }>;
    resumeText?: string;
    legendText?: string;
    vacancyText?: string;
    language: string;
  }) =>
    request<{
      verdict: string;
      interviewerImpression?: string;
      nextPracticePlan: string[];
      focusTopic?: string;
      model?: string;
    }>('/vacancy/report', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    }),

  /** Профиль-пак кандидата: статус кэша (для чеклиста готовности). */
  profilePackStatus: () =>
    request<{
      exists: boolean;
      stale: boolean;
      userEdited?: boolean;
      hasResume: boolean;
      hasLegend: boolean;
      hasVacancy: boolean;
      generatedAt?: number | null;
      model?: string | null;
    }>('/documents/profile-pack/status'),

  /** Содержимое пака — пользователь видит и правит, чем live будет отвечать. */
  profilePackGet: () =>
    request<{
      content: string;
      exists: boolean;
      stale: boolean;
      userEdited?: boolean;
      generatedAt?: number | null;
      model?: string | null;
    }>('/documents/profile-pack'),

  profilePackSave: (content: string) =>
    request<{ exists: boolean; userEdited?: boolean }>('/documents/profile-pack', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  /** Пересобрать профиль-пак из текущих документов (ручной триггер). */
  profilePackRefresh: () =>
    request<{ exists: boolean; stale: boolean }>('/documents/profile-pack/refresh', {
      method: 'POST',
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    }),

  // --- Speech-to-text: fixed OpenAI Mini provider ---
  sttProviders: () => request<SttProviderDiagnostics>('/stt/providers'),

  /** Pre-load + warm the live STT models so the first utterance isn't slow. */
  sttWarmup: () =>
    request<{ warmed: Record<string, string>; ms: number }>('/stt/warmup', {
      method: 'POST',
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    }),

  sttDiagnostics: () => request<SttDiagnostics>('/stt/diagnostics'),

  getSttSettings: () => request<SttSettingsDto>('/stt/settings'),

  saveSttSettings: (settings: Partial<SttSettingsDto>) =>
    request<SttSettingsDto>('/stt/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),

  transcribeMockAnswer: async (
    wav: Blob,
    context: MockAnswerTranscriptionContext,
    options: { signal?: AbortSignal } = {},
  ) => {
    const resp = await fetchWithTimeout('/stt/answer', {
      method: 'POST',
      headers: await authHeaders(),
      body: createMockAnswerTranscriptionForm(wav, context),
      signal: options.signal,
      timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    });
    if (!resp.ok) {
      let message = `Ошибка ${resp.status}`;
      try {
        const data = await resp.json();
        message = data?.error?.message ?? data?.detail ?? message;
      } catch {
        // ignore non-JSON errors
      }
      throw new Error(message);
    }
    return resp.json() as Promise<{ text: string; model: 'gpt-transcribe' }>;
  },

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
        openaiInferenceMs: number;
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
