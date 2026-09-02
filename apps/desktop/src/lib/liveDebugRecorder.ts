/**
 * Live-session debug recorder.
 *
 * Captures, for one live interview session, a precise timeline of everything the
 * STT/LLM pipeline did (with ms-accurate timestamps relative to "Start") plus the
 * raw microphone audio. The bundle answers "what actually happened, and when" —
 * e.g. how long after Start the first partial arrived, whether an utterance was
 * dropped as low-quality, or where a slow answer came from.
 *
 * Everything here is additive and side-effect free: recording never touches the
 * live pipeline's behaviour.
 */

export interface DebugEvent {
  /** Milliseconds since the session started (Start pressed). */
  tMs: number;
  type:
    | 'session_start'
    | 'ready'
    | 'speech_started'
    | 'partial'
    | 'final'
    | 'low_quality'
    | 'answer_blocked'
    | 'answer_started'
    | 'answer_first_token'
    | 'answer_done'
    | 'candidate_hotkey_received'
    | 'candidate_hotkey_queued'
    | 'candidate_hotkey_ignored'
    | 'candidate_hotkey_selected'
    | 'source_warning'
    | 'source_recovered'
    | 'error';
  source?: 'mic' | 'system';
  speaker?: 'me' | 'other';
  text?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

export interface DebugBundle {
  schemaVersion: 1 | 2;
  generatedAt: string;
  sampleRate: number;
  durationMs: number;
  audioFile: string | null;
  events: DebugEvent[];
  extra?: Record<string, unknown>;
  retention?: {
    events: DiagnosticRetention;
    screenAssists?: DiagnosticRetention;
  };
}

export interface DiagnosticRetention {
  limit: number;
  retained: number;
  dropped: number;
  total: number;
}

// ~12 minutes of 16 kHz mono PCM16 — enough for any interview, bounded so a long
// session can't grow memory without limit.
const MAX_SAMPLES = 16000 * 60 * 12;
export const MAX_DEBUG_EVENTS = 1000;

const DATA_URL_RE = /(^|[^a-z0-9_-])data:[^,\s"'<>]*,[^\s"'<>]*/gi;
const BASE64_MARKER_RE = /;base64,[a-z0-9+/=_-]*/gi;
const AUTH_RE = /\b(?:authorization\s*[:=]\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+/gi;
const SECRET_KEY_RE = /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}/gi;
const LABELLED_SECRET_RE = /\b(?:token|api[_-]?key|access[_-]?key|private[_-]?key|license[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi;
const COOKIE_RE = /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const RAW_BASE64_RE = /(^|[\s"'=:])([A-Za-z0-9+/]{32,}={0,2})(?=$|[\s"',;])/g;
const MAX_EVENT_TEXT_CHARS = 550;
const MAX_EXCHANGES = 200;

export function sanitizeDiagnosticText(value: string, limit = 8_000): string {
  return value
    .replace(DATA_URL_RE, '$1[OMITTED_DATA_URL]')
    .replace(BASE64_MARKER_RE, ';[OMITTED_BASE64]')
    .replace(AUTH_RE, '[REDACTED]')
    .replace(SECRET_KEY_RE, '[REDACTED]')
    .replace(LABELLED_SECRET_RE, '[REDACTED]')
    .replace(COOKIE_RE, '[REDACTED]')
    .replace(RAW_BASE64_RE, '$1[OMITTED_BASE64]')
    .slice(0, limit);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundedNumber(value: unknown, fallback = 0): number {
  return Math.max(0, finite(value) ?? fallback);
}

function safeString(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? sanitizeDiagnosticText(value, limit) : undefined;
}

function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

const EVENT_TYPES = new Set<DebugEvent['type']>([
  'session_start', 'ready', 'speech_started', 'partial', 'final', 'low_quality',
  'answer_blocked', 'answer_started', 'answer_first_token', 'answer_done',
  'candidate_hotkey_received', 'candidate_hotkey_queued',
  'candidate_hotkey_ignored', 'candidate_hotkey_selected',
  'source_warning', 'source_recovered', 'error',
]);

function sanitizeEventMeta(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  const result: Record<string, unknown> = {};
  const stringFields = [
    'model', 'modelSource', 'engine', 'readyKind', 'utteranceId', 'recoveredFrom',
    'hotkeySource', 'contextSource', 'phase',
  ];
  const numberFields = [
    'sampleRate', 'sttLatencyMs', 'llmLatencyMs', 'speechEndToFinalMs',
    'openaiInferenceMs', 'queueWaitMs', 'queueDepth', 'capturedAtMs', 'captureEpoch',
    'generation', 'sequence',
  ];
  const booleanFields = ['reconnected', 'recoverable', 'nonFatal'];
  stringFields.forEach((key) => put(result, key, safeString(source[key], 300)));
  numberFields.forEach((key) => put(result, key, finite(source[key])));
  booleanFields.forEach((key) => {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  });
  return Object.keys(result).length ? result : undefined;
}

function sanitizeDebugEvent(value: unknown): DebugEvent | null {
  const source = record(value);
  if (typeof source.type !== 'string' || !EVENT_TYPES.has(source.type as DebugEvent['type'])) {
    return null;
  }
  const event: DebugEvent = {
    tMs: boundedNumber(source.tMs),
    type: source.type as DebugEvent['type'],
  };
  if (source.source === 'mic' || source.source === 'system') event.source = source.source;
  if (source.speaker === 'me' || source.speaker === 'other') event.speaker = source.speaker;
  event.text = safeString(source.text, MAX_EVENT_TEXT_CHARS);
  event.reason = safeString(source.reason, MAX_EVENT_TEXT_CHARS);
  event.meta = sanitizeEventMeta(source.meta);
  return event;
}

function sanitizeRetention(
  value: unknown,
  limit: number,
  retained: number,
  inputCount: number,
): DiagnosticRetention {
  const source = record(value);
  const priorDropped = Math.max(0, Math.round(finite(source.dropped) ?? 0));
  const dropped = priorDropped + Math.max(0, inputCount - retained);
  return {
    limit,
    retained,
    dropped,
    total: Math.max(retained + dropped, Math.round(finite(source.total) ?? retained + dropped)),
  };
}

function sanitizeSources(value: unknown): Record<string, boolean> | undefined {
  const source = record(value);
  const result: Record<string, boolean> = {};
  if (typeof source.mic === 'boolean') result.mic = source.mic;
  if (typeof source.system === 'boolean') result.system = source.system;
  return Object.keys(result).length ? result : undefined;
}

function sanitizeSourceState(value: unknown): Record<string, unknown> {
  const source = record(value);
  const result: Record<string, unknown> = {};
  ['requested', 'ready'].forEach((key) => {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  });
  ['readyAtMs', 'captureEpoch', 'firstFrameAtMs', 'firstSignalAtMs', 'firstSpeechAtMs', 'signalFrameCount', 'speechStartCount']
    .forEach((key) => {
      if (source[key] === null) result[key] = null;
      else put(result, key, finite(source[key]));
    });
  if (source.warning === null) result.warning = null;
  else put(result, 'warning', safeString(source.warning, 300));
  return result;
}

function sanitizeSourceHealth(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  const rawSources = record(source.sources);
  const sources: Record<string, unknown> = {};
  if (rawSources.mic && typeof rawSources.mic === 'object') sources.mic = sanitizeSourceState(rawSources.mic);
  if (rawSources.system && typeof rawSources.system === 'object') sources.system = sanitizeSourceState(rawSources.system);
  const result: Record<string, unknown> = {};
  if (Object.keys(sources).length) result.sources = sources;
  if (source.warning === null) result.warning = null;
  else put(result, 'warning', safeString(source.warning, 300));
  return Object.keys(result).length ? result : undefined;
}

function sanitizeStt(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  const result: Record<string, unknown> = {};
  put(result, 'utteranceId', safeString(source.utteranceId, 300));
  if (source.source === 'mic' || source.source === 'system') result.source = source.source;
  ['capturedAtMs', 'queueWaitMs', 'queueDepth', 'speechEndToFinalMs', 'openaiInferenceMs']
    .forEach((key) => put(result, key, finite(source[key])));
  return Object.keys(result).length ? result : undefined;
}

function sanitizeLatency(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  const result: Record<string, unknown> = {};
  ['sttLatencyMs', 'llmLatencyMs', 'totalLatencyMs'].forEach((key) => {
    if (source[key] === null) result[key] = null;
    else put(result, key, finite(source[key]));
  });
  const breakdownSource = record(source.breakdown);
  const breakdown: Record<string, unknown> = {};
  ['speechEndToFinalMs', 'speechStartToFinalMs', 'finalToAnswerStartMs', 'llmFirstTokenMs', 'llmTotalMs', 'sessionElapsedToFinalMs']
    .forEach((key) => put(breakdown, key, finite(breakdownSource[key])));
  if (Object.keys(breakdown).length) result.breakdown = breakdown;
  return Object.keys(result).length ? result : undefined;
}

function sanitizePipeline(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  const result: Record<string, unknown> = {};
  const shortStrings = ['model', 'modelSource', 'previousTopic', 'currentCanonicalTopic', 'followUpReason', 'resetPreviousTopicReason', 'questionIntent', 'answerStrategy', 'hallucinationRisk', 'resumeContextLevel', 'resumeContextReason'];
  const textStrings = ['rawTranscript', 'normalizedTranscript', 'resolvedQuestion'];
  const booleans = ['isFollowUp', 'usedPreviousContext', 'wasPreviousTopicUsed', 'resetPreviousTopic', 'resumeContextUsed'];
  shortStrings.forEach((key) => put(result, key, safeString(source[key], 500)));
  textStrings.forEach((key) => put(result, key, safeString(source[key], 2_000)));
  booleans.forEach((key) => { if (typeof source[key] === 'boolean') result[key] = source[key]; });
  ['timeToAnswerMs', 'timeToFinalMs'].forEach((key) => put(result, key, finite(source[key])));
  const knowledgeSource = record(source.knowledge);
  const knowledge: Record<string, unknown> = {};
  if (typeof knowledgeSource.knowledgePackUsed === 'boolean') knowledge.knowledgePackUsed = knowledgeSource.knowledgePackUsed;
  ['knowledgePackName', 'knowledgeSource'].forEach((key) => put(knowledge, key, safeString(knowledgeSource[key], 300)));
  ['retrievedItemsCount', 'injectedContextTokens', 'knowledgeRetrievalMs', 'answerLatencyWithKnowledgeMs']
    .forEach((key) => put(knowledge, key, finite(knowledgeSource[key])));
  if (Object.keys(knowledge).length) result.knowledge = knowledge;
  return Object.keys(result).length ? result : undefined;
}

function sanitizeExchange(value: unknown): Record<string, unknown> {
  const source = record(value);
  const result: Record<string, unknown> = {};
  put(result, 'id', safeString(source.id, 300));
  put(result, 'question', safeString(source.question, 2_000));
  put(result, 'spoken', safeString(source.spoken, 8_000));
  put(result, 'ts', finite(source.ts));
  if (source.source === 'live' || source.source === 'manual') result.source = source.source;
  put(result, 'pipeline', sanitizePipeline(source.pipeline));
  put(result, 'latency', sanitizeLatency(source.latency));
  put(result, 'stt', sanitizeStt(source.stt));
  return result;
}

function sanitizeScreenAssist(value: unknown): Record<string, unknown> | null {
  const source = record(value);
  const id = safeString(source.id, 300);
  if (!id) return null;
  const result: Record<string, unknown> = { id };
  put(result, 'generation', finite(source.generation));
  put(result, 'startedAtMs', finite(source.startedAtMs));
  if (source.trigger === 'manual' || source.trigger === 'visual_question' || source.trigger === 'stt_timeout') result.trigger = source.trigger;
  put(result, 'mode', safeString(source.mode, 80));
  put(result, 'effectiveQuestion', safeString(source.effectiveQuestion, 2_000));
  if (['requested', 'captured', 'done', 'error', 'cancelled'].includes(String(source.status))) result.status = source.status;
  put(result, 'model', safeString(source.model, 200));
  put(result, 'modelSource', safeString(source.modelSource, 100));
  put(result, 'answer', safeString(source.answer, 8_000));
  put(result, 'error', safeString(source.error, 1_000));
  ['captureMs', 'firstOutputMs', 'totalMs', 'encodedByteCount'].forEach((key) => put(result, key, finite(source[key])));
  put(result, 'imageMimeType', safeString(source.imageMimeType, 100));
  return result;
}

function sanitizeExtra(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  const result: Record<string, unknown> = {};
  put(result, 'stt', sanitizeEventMeta(source.stt));
  put(result, 'sources', sanitizeSources(source.sources));
  put(result, 'sourceHealth', sanitizeSourceHealth(source.sourceHealth));
  if (Array.isArray(source.exchanges)) {
    result.exchanges = source.exchanges.slice(-MAX_EXCHANGES).map(sanitizeExchange);
  }
  if (Array.isArray(source.screenAssists)) {
    result.screenAssists = source.screenAssists
      .map(sanitizeScreenAssist)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .slice(-40);
  }
  return Object.keys(result).length ? result : undefined;
}

/** Schema-v2 field factory: unknown keys never cross the persistence boundary. */
export function sanitizeDebugBundle(value: unknown): DebugBundle {
  const source = record(value);
  const rawEvents = Array.isArray(source.events) ? source.events : [];
  const events = rawEvents
    .map(sanitizeDebugEvent)
    .filter((event): event is DebugEvent => Boolean(event))
    .slice(-MAX_DEBUG_EVENTS);
  const rawRetention = record(source.retention);
  const rawExtra = record(source.extra);
  const rawScreens = Array.isArray(rawExtra.screenAssists) ? rawExtra.screenAssists : [];
  const extra = sanitizeExtra(source.extra);
  const screens = Array.isArray(extra?.screenAssists) ? extra.screenAssists.length : 0;
  return {
    schemaVersion: 2,
    generatedAt: safeString(source.generatedAt, 100) ?? new Date().toISOString(),
    sampleRate: boundedNumber(source.sampleRate, 16_000),
    durationMs: boundedNumber(source.durationMs),
    audioFile: source.audioFile === null ? null : safeString(source.audioFile, 255) ?? null,
    events,
    ...(extra ? { extra } : {}),
    retention: {
      events: sanitizeRetention(rawRetention.events, MAX_DEBUG_EVENTS, events.length, rawEvents.length),
      screenAssists: sanitizeRetention(rawRetention.screenAssists, 40, screens, rawScreens.length),
    },
  };
}

export class LiveDebugRecorder {
  private events: DebugEvent[] = [];
  private audio: Int16Array[] = [];
  private sampleRate = 16000;
  private t0 = 0;
  private samples = 0;
  private droppedEvents = 0;
  private totalEvents = 0;

  /** Reset and begin a new recording. */
  start(sampleRate: number): void {
    this.events = [];
    this.audio = [];
    this.samples = 0;
    this.droppedEvents = 0;
    this.totalEvents = 0;
    this.sampleRate = sampleRate || 16000;
    this.t0 = performance.now();
    this.event('session_start', { meta: { sampleRate: this.sampleRate } });
  }

  setSampleRate(sampleRate: number): void {
    if (sampleRate) this.sampleRate = sampleRate;
  }

  event(type: DebugEvent['type'], data: Omit<Partial<DebugEvent>, 'type' | 'tMs'> = {}): void {
    if (this.t0 === 0) return; // not started
    this.totalEvents += 1;
    this.events.push({ tMs: Math.round(performance.now() - this.t0), type, ...data });
    if (this.events.length > MAX_DEBUG_EVENTS) {
      const overflow = this.events.length - MAX_DEBUG_EVENTS;
      this.events.splice(0, overflow);
      this.droppedEvents += overflow;
    }
  }

  /** Tee one PCM16 frame (the exact bytes sent to the server). */
  audioFrame(buffer: ArrayBuffer): void {
    if (this.t0 === 0 || this.samples >= MAX_SAMPLES) return;
    const frame = new Int16Array(buffer.slice(0));
    this.audio.push(frame);
    this.samples += frame.length;
  }

  hasData(): boolean {
    return this.events.length > 0;
  }

  private durationMs(): number {
    return this.t0 === 0 ? 0 : Math.round(performance.now() - this.t0);
  }

  buildJson(audioFile: string | null, extra?: Record<string, unknown>): DebugBundle {
    const bundle: DebugBundle = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      sampleRate: this.sampleRate,
      durationMs: this.durationMs(),
      audioFile,
      events: this.events,
      extra,
      retention: {
        events: {
          limit: MAX_DEBUG_EVENTS,
          retained: this.events.length,
          dropped: this.droppedEvents,
          total: this.totalEvents,
        },
      },
    };
    return sanitizeDebugBundle(bundle);
  }

  /** Encode the recorded PCM16 frames into a mono WAV blob (or null if silent). */
  buildWav(): Blob | null {
    if (this.samples === 0) return null;
    const pcm = new Int16Array(this.samples);
    let offset = 0;
    for (const frame of this.audio) {
      pcm.set(frame, offset);
      offset += frame.length;
    }
    return encodeWav(pcm, this.sampleRate);
  }
}

/** Minimal 16-bit mono PCM → WAV container. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Blob {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(pos + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let pos = 44;
  for (let i = 0; i < pcm.length; i += 1, pos += 2) view.setInt16(pos, pcm[i], true);
  return new Blob([buffer], { type: 'audio/wav' });
}
