import {
  MAX_DEBUG_EVENTS,
  sanitizeDebugBundle,
  sanitizeDiagnosticText,
  type DebugBundle,
  type DebugEvent,
  type DiagnosticRetention,
} from './liveDebugRecorder';

export const MAX_SCREEN_ASSISTS = 40;
const MAX_SCREEN_QUESTION_CHARS = 2_000;
const MAX_SCREEN_ANSWER_CHARS = 8_000;
const MAX_SCREEN_ERROR_CHARS = 1_000;
const MAX_PARTIAL_HINT_CHARS = 500;
const MAX_PARTIAL_RECEIVED_AGE_MS = 5_000;
const MAX_PARTIAL_CAPTURE_AGE_MS = 20_000;

export type ScreenAssistTrigger = 'manual' | 'visual_question' | 'stt_timeout';
export type ScreenAssistStatus = 'requested' | 'captured' | 'done' | 'error' | 'cancelled';

export interface ScreenAssistDiagnosticEntry {
  id: string;
  generation: number;
  startedAtMs: number;
  trigger: ScreenAssistTrigger;
  mode: string;
  effectiveQuestion: string;
  status: ScreenAssistStatus;
  model?: string;
  modelSource?: string;
  answer?: string;
  error?: string;
  captureMs?: number;
  firstOutputMs?: number;
  totalMs?: number;
  imageMimeType?: string;
  encodedByteCount?: number;
}

export interface ScreenAssistSnapshot {
  entries: ScreenAssistDiagnosticEntry[];
  retention: DiagnosticRetention;
}

export interface ScreenPartialCandidate {
  text: string;
  source: 'mic' | 'system';
  receivedAtMs: number;
  capturedAtMs?: number;
  active: boolean;
  rejected: boolean;
}

/** Shared hook→Overlay owner for synchronously invalidating an active screen operation. */
export class ActiveScreenAssistCancellation {
  private activeCancel: (() => void) | null = null;

  register(cancel: (() => void) | null): void {
    this.activeCancel = cancel;
  }

  cancelAndClear(): boolean {
    const cancel = this.activeCancel;
    if (!cancel) return false;
    this.activeCancel = null;
    cancel();
    return true;
  }
}

function safeText(value: string, limit: number): string {
  return sanitizeDiagnosticText(value, limit).trim();
}

function encodedImageMetadata(image: string): {
  imageMimeType?: string;
  encodedByteCount: number;
} {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=_-]*)$/i.exec(image.trim());
  const encoded = match?.[2] ?? image.trim();
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return {
    ...(match?.[1] ? { imageMimeType: match[1].toLowerCase() } : {}),
    encodedByteCount: Math.max(0, Math.floor((encoded.length * 3) / 4) - padding),
  };
}

function isTerminal(status: ScreenAssistStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

export class ScreenAssistDiagnostics {
  private entries: ScreenAssistDiagnosticEntry[] = [];
  private dropped = 0;
  private total = 0;
  private sessionStartedAt = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(sessionStartedAt = this.now()): void {
    this.entries = [];
    this.dropped = 0;
    this.total = 0;
    this.sessionStartedAt = sessionStartedAt;
  }

  request(input: {
    id: string;
    generation: number;
    trigger: ScreenAssistTrigger;
    mode: string;
    effectiveQuestion: string;
  }): string {
    const entry: ScreenAssistDiagnosticEntry = {
      id: input.id,
      generation: input.generation,
      startedAtMs: Math.max(0, Math.round(this.now() - this.sessionStartedAt)),
      trigger: input.trigger,
      mode: safeText(input.mode, 80),
      effectiveQuestion: safeText(input.effectiveQuestion, MAX_SCREEN_QUESTION_CHARS),
      status: 'requested',
    };
    this.entries.push(entry);
    this.total += 1;
    if (this.entries.length > MAX_SCREEN_ASSISTS) {
      const overflow = this.entries.length - MAX_SCREEN_ASSISTS;
      this.entries.splice(0, overflow);
      this.dropped += overflow;
    }
    return entry.id;
  }

  private mutable(id: string): ScreenAssistDiagnosticEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === id);
    return entry && !isTerminal(entry.status) ? entry : undefined;
  }

  captured(id: string, image: string): boolean {
    const entry = this.mutable(id);
    if (!entry || entry.status !== 'requested') return false;
    entry.status = 'captured';
    entry.captureMs = Math.max(0, Math.round(this.now() - this.sessionStartedAt - entry.startedAtMs));
    Object.assign(entry, encodedImageMetadata(image));
    return true;
  }

  firstOutput(id: string, chunk: string): boolean {
    const entry = this.mutable(id);
    if (!entry || !chunk.trim() || entry.firstOutputMs != null) return false;
    entry.firstOutputMs = Math.max(0, Math.round(this.now() - this.sessionStartedAt - entry.startedAtMs));
    return true;
  }

  done(id: string, result: { answer: string; model?: string; modelSource?: string }): boolean {
    const entry = this.mutable(id);
    if (!entry) return false;
    entry.status = 'done';
    entry.answer = safeText(result.answer, MAX_SCREEN_ANSWER_CHARS);
    if (result.model) entry.model = safeText(result.model, 200);
    if (result.modelSource) entry.modelSource = safeText(result.modelSource, 100);
    entry.totalMs = Math.max(0, Math.round(this.now() - this.sessionStartedAt - entry.startedAtMs));
    return true;
  }

  error(id: string, reason: string): boolean {
    const entry = this.mutable(id);
    if (!entry) return false;
    entry.status = 'error';
    entry.error = safeText(reason, MAX_SCREEN_ERROR_CHARS);
    entry.totalMs = Math.max(0, Math.round(this.now() - this.sessionStartedAt - entry.startedAtMs));
    return true;
  }

  cancel(id: string): boolean {
    const entry = this.mutable(id);
    if (!entry) return false;
    entry.status = 'cancelled';
    entry.totalMs = Math.max(0, Math.round(this.now() - this.sessionStartedAt - entry.startedAtMs));
    return true;
  }

  snapshot(): ScreenAssistSnapshot {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      retention: {
        limit: MAX_SCREEN_ASSISTS,
        retained: this.entries.length,
        dropped: this.dropped,
        total: this.total,
      },
    };
  }
}

export function freezeTimeoutScreenPartial(input: {
  partial: ScreenPartialCandidate | null | undefined;
  selectedSource: 'mic' | 'system' | null;
  pressedAtMs: number;
}): string | undefined {
  const { partial, selectedSource, pressedAtMs } = input;
  if (!partial || !selectedSource || partial.source !== selectedSource) return undefined;
  if (!partial.active || partial.rejected) return undefined;
  if (partial.receivedAtMs > pressedAtMs) return undefined;
  if (pressedAtMs - partial.receivedAtMs > MAX_PARTIAL_RECEIVED_AGE_MS) return undefined;
  if (partial.capturedAtMs == null) return undefined;
  if (partial.capturedAtMs > pressedAtMs) return undefined;
  if (pressedAtMs - partial.capturedAtMs > MAX_PARTIAL_CAPTURE_AGE_MS) return undefined;
  const hint = partial.text.trim().slice(0, MAX_PARTIAL_HINT_CHARS);
  return hint || undefined;
}

/** Owns partial candidates and generation-frozen hints across capture lifecycle changes. */
export class TimeoutScreenPartialState {
  private candidates: Record<'mic' | 'system', ScreenPartialCandidate | null> = {
    mic: null,
    system: null,
  };
  private hints = new Map<number, string | undefined>();

  observe(candidate: ScreenPartialCandidate): void {
    this.candidates[candidate.source] = { ...candidate };
  }

  clearCandidate(source: 'mic' | 'system'): void {
    this.candidates[source] = null;
  }

  clearCandidates(): void {
    this.candidates = { mic: null, system: null };
  }

  freezeGeneration(
    generation: number,
    selectedSource: 'mic' | 'system' | null,
    pressedAtMs: number,
  ): void {
    this.hints.set(generation, freezeTimeoutScreenPartial({
      partial: selectedSource ? this.candidates[selectedSource] : null,
      selectedSource,
      pressedAtMs,
    }));
  }

  hintFor(generation: number): string | undefined {
    return this.hints.get(generation);
  }

  clearGeneration(generation: number): void {
    this.hints.delete(generation);
  }

  reset(): void {
    this.clearCandidates();
    this.hints.clear();
  }
}

interface PendingWrite {
  epoch: number;
  sessionId: string;
  buildSnapshot: () => DebugBundle;
}

interface WriteState {
  pending: PendingWrite | null;
  running: boolean;
  error: unknown;
  waiters: Array<() => void>;
}

/** One in-flight PUT globally; only the latest pending snapshot survives. */
export class SerializedDiagnosticsWriter {
  private activeEpoch = 0;
  private activeSessionId: string | null = null;
  private states = new Map<string, WriteState>();
  private queuedKeys: string[] = [];
  private runningKey: string | null = null;

  constructor(
    private readonly save: (sessionId: string, snapshot: DebugBundle) => Promise<unknown>,
  ) {}

  activate(epoch: number, sessionId: string): void {
    this.activeEpoch = epoch;
    this.activeSessionId = sessionId;
  }

  private key(epoch: number, sessionId: string): string {
    return `${epoch}\u0000${sessionId}`;
  }

  private state(epoch: number, sessionId: string): WriteState {
    const key = this.key(epoch, sessionId);
    const existing = this.states.get(key);
    if (existing) return existing;
    const created: WriteState = { pending: null, running: false, error: null, waiters: [] };
    this.states.set(key, created);
    return created;
  }

  enqueue(
    epoch: number,
    sessionId: string,
    buildSnapshot: () => DebugBundle,
  ): boolean {
    if (epoch !== this.activeEpoch || sessionId !== this.activeSessionId) return false;
    const key = this.key(epoch, sessionId);
    const state = this.state(epoch, sessionId);
    state.pending = { epoch, sessionId, buildSnapshot };
    if (!this.queuedKeys.includes(key)) this.queuedKeys.push(key);
    this.pump();
    return true;
  }

  private pump(): void {
    if (this.runningKey) return;
    const key = this.queuedKeys.shift();
    if (!key) return;
    const state = this.states.get(key);
    const write = state?.pending;
    if (!state || !write) {
      this.pump();
      return;
    }
    state.pending = null;
    state.running = true;
    this.runningKey = key;
    void (async () => {
      const snapshot = sanitizeDebugBundle(write.buildSnapshot());
      await this.save(write.sessionId, snapshot);
    })()
      .then(() => { state.error = null; })
      .catch((error: unknown) => { state.error = error; })
      .finally(() => {
        state.running = false;
        this.runningKey = null;
        if (state.pending && !this.queuedKeys.includes(key)) this.queuedKeys.push(key);
        const waiters = state.waiters.splice(0);
        waiters.forEach((resolve) => resolve());
        this.pump();
      });
  }

  async flush(epoch: number, sessionId: string): Promise<void> {
    const key = this.key(epoch, sessionId);
    const state = this.states.get(key);
    if (!state) return;
    while (state.running || state.pending || this.queuedKeys.includes(key)) {
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
    if (state.error) throw state.error;
  }
}

function retentionForEvents(bundle: DebugBundle): DiagnosticRetention {
  return bundle.retention?.events ?? {
    limit: MAX_DEBUG_EVENTS,
    retained: bundle.events.length,
    dropped: 0,
    total: bundle.events.length,
  };
}

function screenEntries(bundle: DebugBundle): ScreenAssistDiagnosticEntry[] {
  const entries = bundle.extra?.screenAssists;
  return Array.isArray(entries) ? entries as ScreenAssistDiagnosticEntry[] : [];
}

function uniqueById(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = value && typeof value === 'object' && 'id' in value
      ? String((value as { id?: unknown }).id ?? '')
      : '';
    if (!id || seen.has(id)) return !id;
    seen.add(id);
    return true;
  });
}

/** Merge a newly recorded segment with diagnostics already stored under a reused ID. */
export function mergeDebugBundles(
  previous: DebugBundle | null | undefined,
  current: DebugBundle,
): DebugBundle {
  if (!previous) return sanitizeDebugBundle(current);
  const previousEventRetention = retentionForEvents(previous);
  const currentEventRetention = retentionForEvents(current);
  const offsetMs = Math.max(0, previous.durationMs);
  const currentEvents = current.events.map((event) => ({ ...event, tMs: event.tMs + offsetMs }));
  const allEvents = [...previous.events, ...currentEvents];
  const overflowEvents = Math.max(0, allEvents.length - MAX_DEBUG_EVENTS);
  const events = allEvents.slice(-MAX_DEBUG_EVENTS) as DebugEvent[];
  const currentScreens = screenEntries(current).map((screen) => ({
    ...screen,
    startedAtMs: screen.startedAtMs + offsetMs,
  }));
  const allScreens = [...screenEntries(previous), ...currentScreens];
  const overflowScreens = Math.max(0, allScreens.length - MAX_SCREEN_ASSISTS);
  const screens = allScreens.slice(-MAX_SCREEN_ASSISTS);
  const previousScreenRetention = previous.retention?.screenAssists;
  const currentScreenRetention = current.retention?.screenAssists;
  const previousExchanges = Array.isArray(previous.extra?.exchanges) ? previous.extra.exchanges : [];
  const currentExchanges = Array.isArray(current.extra?.exchanges) ? current.extra.exchanges : [];
  const merged: DebugBundle = {
    ...current,
    schemaVersion: 2,
    durationMs: Math.max(0, previous.durationMs) + Math.max(0, current.durationMs),
    events,
    retention: {
      events: {
        limit: MAX_DEBUG_EVENTS,
        retained: events.length,
        dropped: previousEventRetention.dropped + currentEventRetention.dropped + overflowEvents,
        total: previousEventRetention.total + currentEventRetention.total,
      },
      screenAssists: {
        limit: MAX_SCREEN_ASSISTS,
        retained: screens.length,
        dropped:
          (previousScreenRetention?.dropped ?? 0) +
          (currentScreenRetention?.dropped ?? 0) +
          overflowScreens,
        total:
          (previousScreenRetention?.total ?? screenEntries(previous).length) +
          (currentScreenRetention?.total ?? screenEntries(current).length),
      },
    },
    extra: {
      ...(previous.extra ?? {}),
      ...(current.extra ?? {}),
      exchanges: uniqueById([...previousExchanges, ...currentExchanges]),
      screenAssists: screens,
    },
  };
  return sanitizeDebugBundle(merged);
}
