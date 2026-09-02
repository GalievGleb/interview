/**
 * Типизированное состояние экрана содержит чувствительный OCR-контекст собеседования.
 * Храним его только в памяти renderer: не пишем в localStorage, отчёты и диагностику.
 */

export const MAX_SCREEN_TASK_STATE_CHARS = 400_000;
export const MAX_SCREEN_TASK_STATE_TTL_MS = 2 * 60 * 60 * 1_000;

/**
 * Rollout is intentionally separate from the build channel: accepting the
 * implementation must never make a stable/production renderer opt in.
 */
const STRUCTURED_SCREEN_ROLLOUT_READY = true;

export function resolveStructuredScreenAssistEnabled(
  mode: string,
  rolloutReady: boolean,
): boolean {
  return rolloutReady && mode === 'alphabuild';
}

/** Единый флаг нового серверного конвейера; stable всегда остаётся на legacy. */
export const STRUCTURED_SCREEN_ASSIST_ENABLED = resolveStructuredScreenAssistEnabled(
  import.meta.env.MODE,
  STRUCTURED_SCREEN_ROLLOUT_READY,
);

declare const opaqueScreenTaskStateBrand: unique symbol;
export type OpaqueScreenTaskState = string & {
  readonly [opaqueScreenTaskStateBrand]: true;
};

export interface ParsedScreenTaskState {
  value: OpaqueScreenTaskState;
  expiresAtMs: number;
}

export type ScreenTaskAction = 'new' | 'continue';

export interface ScreenTaskStateLease {
  generation: number;
  taskAction: ScreenTaskAction;
  taskState?: OpaqueScreenTaskState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TASK_KINDS = new Set(['analysis', 'list', 'find_defect', 'code', 'other']);
const RESPONSE_KINDS = new Set([
  'analysis_findings',
  'code_solution',
  'checklist',
  'direct_answer',
  'execution_result',
]);
const CORRECTION_MODES = new Set(['accumulate', 'refine', 'exact_new']);
const MAX_REQUIREMENT_OBJECTIVE_CHARS = 1_200;
const DATA_URL_RE = /data:[^\s,]{0,160},/i;
const LONG_BASE64_RE = /[A-Za-z0-9+/_-]{256,}={0,2}/;

function containsBinaryPayload(value: unknown): boolean {
  if (typeof value === 'string') {
    const compact = value.replace(/\s+/g, '');
    return DATA_URL_RE.test(value)
      || compact.toLowerCase().includes('base64,')
      || LONG_BASE64_RE.test(compact);
  }
  if (Array.isArray(value)) return value.some(containsBinaryPayload);
  if (isRecord(value)) return Object.values(value).some(containsBinaryPayload);
  return false;
}

/**
 * Проверяем только транспортную оболочку. Для UI содержимое остаётся непрозрачным:
 * полной схемой и смысловой проверкой владеет backend.
 */
export function parseOpaqueScreenTaskState(
  raw: unknown,
  nowMs = Date.now(),
): ParsedScreenTaskState | null {
  if (
    typeof raw !== 'string'
    || raw.length === 0
    || raw.length > MAX_SCREEN_TASK_STATE_CHARS
    || !Number.isFinite(nowMs)
  ) return null;

  try {
    const root: unknown = JSON.parse(raw);
    if (
      !isRecord(root)
      || root.version !== 1
      || typeof root.task_kind !== 'string'
      || !TASK_KINDS.has(root.task_kind)
      || typeof root.response_kind !== 'string'
      || !RESPONSE_KINDS.has(root.response_kind)
      || typeof root.correction_mode !== 'string'
      || !CORRECTION_MODES.has(root.correction_mode)
      || !isRecord(root.requirements)
      || typeof root.requirements.objective !== 'string'
      || root.requirements.objective.length === 0
      || root.requirements.objective.length > MAX_REQUIREMENT_OBJECTIVE_CHARS
      || !Array.isArray(root.frames)
      || !Array.isArray(root.ledger)
      || !isRecord(root.ttl)
      || containsBinaryPayload(root)
    ) return null;
    const createdAtMs = root.ttl.created_at_ms;
    const updatedAtMs = root.ttl.updated_at_ms;
    const expiresAtMs = root.ttl.expires_at_ms;
    if (
      !Number.isSafeInteger(createdAtMs)
      || !Number.isSafeInteger(updatedAtMs)
      || !Number.isSafeInteger(expiresAtMs)
      || (createdAtMs as number) < 0
      || (updatedAtMs as number) < 0
      || (expiresAtMs as number) < 0
      || (updatedAtMs as number) < (createdAtMs as number)
      || (expiresAtMs as number) <= nowMs
      || (expiresAtMs as number) < (updatedAtMs as number)
      || (expiresAtMs as number) - (updatedAtMs as number) > MAX_SCREEN_TASK_STATE_TTL_MS
      || (expiresAtMs as number) - nowMs > MAX_SCREEN_TASK_STATE_TTL_MS
    ) return null;
    return {
      value: raw as OpaqueScreenTaskState,
      expiresAtMs: expiresAtMs as number,
    };
  } catch {
    return null;
  }
}

/** Безопасное по эпохе хранилище последнего подтверждённого сервером состояния. */
export class ScreenTaskStateMemory {
  private generation = 0;
  private retained: ParsedScreenTaskState | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  beginRequest(action: ScreenTaskAction): ScreenTaskStateLease {
    this.expire();
    if (action === 'new') this.clearRetained();
    const generation = ++this.generation;
    return action === 'continue' && this.retained
      ? { generation, taskAction: 'continue', taskState: this.retained.value }
      : { generation, taskAction: 'new', taskState: undefined };
  }

  commit(generation: number, raw: unknown): boolean {
    if (generation !== this.generation) return false;
    const parsed = parseOpaqueScreenTaskState(raw, this.now());
    if (!parsed) return false;
    this.retained = parsed;
    this.scheduleExpiry();
    return true;
  }

  /** Отменяет владельца активного запроса, сохраняя последнее завершённое состояние. */
  invalidatePending(generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    this.generation += 1;
  }

  current(): OpaqueScreenTaskState | undefined {
    this.expire();
    return this.retained?.value;
  }

  reset(): void {
    this.generation += 1;
    this.clearRetained();
  }

  private expire(): void {
    if (this.retained && this.now() >= this.retained.expiresAtMs) this.clearRetained();
  }

  private clearRetained(): void {
    this.retained = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (!this.retained) {
      this.expiryTimer = null;
      return;
    }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expire();
      if (this.retained) this.scheduleExpiry();
    }, Math.max(0, this.retained.expiresAtMs - this.now()));
  }
}
