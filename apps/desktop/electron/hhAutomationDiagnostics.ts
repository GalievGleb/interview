import type { HhAssistantConfig } from './hhAssistantPolicy';

export type HhAutomationDiagnosticSource =
  | 'daily_search'
  | 'queue_resume'
  | 'manual'
  | 'direct_link'
  | 'configuration'
  | 'application';

export type HhAutomationDiagnosticKind =
  | 'app_restored'
  | 'config_saved'
  | 'timer_scheduled'
  | 'timer_skipped'
  | 'timer_fired'
  | 'run_started'
  | 'run_finished'
  | 'vacancy_started'
  | 'vacancy_finished';

export interface HhAutomationQueueCounts {
  total: number;
  actionable: number;
  eligible: number;
  dailyBlocked: number;
  manualBlocked: number;
  sentToday: number;
}

export interface HhAutomationDiagnosticEvent {
  id: string;
  at: string;
  localAt: string;
  timezone: string;
  utcOffsetMinutes: number;
  kind: HhAutomationDiagnosticKind;
  source: HhAutomationDiagnosticSource;
  reason: string;
  scheduledFor?: string;
  localScheduledFor?: string;
  delayMs?: number;
  runId?: string;
  autoRunDaily: boolean;
  autoRunHour: number;
  autoSend: boolean;
  queuePaused: boolean;
  queue: HhAutomationQueueCounts;
  result?: {
    status: string;
    attempted: number;
    sent: number;
    needsAttention: number;
  };
  vacancy?: {
    key: string;
    title: string;
    company: string;
    status: string;
    gate?: 'manual' | 'daily';
    blocked: boolean;
  };
}

export interface HhAutomationDiagnosticFinding {
  severity: 'info' | 'warning';
  code: string;
  message: string;
  eventId?: string;
}

export interface HhAutomationDiagnosticSnapshot {
  schemaVersion: 1;
  exportedAt: string;
  timezone: string;
  explanation: string;
  config: Pick<HhAssistantConfig, 'autoRunDaily' | 'autoRunHour' | 'autoSend' | 'dailyLimit'>;
  queue: HhAutomationQueueCounts;
  findings: HhAutomationDiagnosticFinding[];
  events: HhAutomationDiagnosticEvent[];
}

export interface HhAutomationCoverageSummary {
  runs: number;
  attempted: number;
  sent: number;
  needsAttention: number;
  transientRetries: number;
}

const KINDS = new Set<HhAutomationDiagnosticKind>([
  'app_restored',
  'config_saved',
  'timer_scheduled',
  'timer_skipped',
  'timer_fired',
  'run_started',
  'run_finished',
  'vacancy_started',
  'vacancy_finished',
]);

const SOURCES = new Set<HhAutomationDiagnosticSource>([
  'daily_search',
  'queue_resume',
  'manual',
  'direct_link',
  'configuration',
  'application',
]);

export function localDiagnosticTime(value: Date): string {
  const offsetMs = value.getTimezoneOffset() * 60_000;
  const local = new Date(value.getTime() - offsetMs).toISOString().replace('Z', '');
  const offset = -value.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${local}${sign}${hours}:${minutes}`;
}

export function diagnosticTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
}

function safeCount(value: unknown): number {
  return Math.max(0, Math.min(10_000, Math.round(Number(value) || 0)));
}

export function normalizeHhAutomationDiagnostics(value: unknown): HhAutomationDiagnosticEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): HhAutomationDiagnosticEvent[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const at = String(item.at ?? '');
    const kind = String(item.kind ?? '') as HhAutomationDiagnosticKind;
    const source = String(item.source ?? '') as HhAutomationDiagnosticSource;
    if (Number.isNaN(Date.parse(at)) || !KINDS.has(kind) || !SOURCES.has(source)) return [];
    const queue = (item.queue && typeof item.queue === 'object' ? item.queue : {}) as Record<string, unknown>;
    const scheduledFor = typeof item.scheduledFor === 'string' && !Number.isNaN(Date.parse(item.scheduledFor))
      ? item.scheduledFor
      : undefined;
    const result = item.result && typeof item.result === 'object'
      ? item.result as Record<string, unknown>
      : null;
    const vacancy = item.vacancy && typeof item.vacancy === 'object'
      ? item.vacancy as Record<string, unknown>
      : null;
    return [{
      id: String(item.id ?? `${at}-${kind}`).slice(0, 160),
      at,
      localAt: String(item.localAt ?? at).slice(0, 80),
      timezone: String(item.timezone ?? 'local').slice(0, 100),
      utcOffsetMinutes: Math.max(-14 * 60, Math.min(14 * 60, Math.round(Number(item.utcOffsetMinutes) || 0))),
      kind,
      source,
      reason: String(item.reason ?? '').slice(0, 240),
      scheduledFor,
      localScheduledFor: scheduledFor ? String(item.localScheduledFor ?? scheduledFor).slice(0, 80) : undefined,
      delayMs: Number.isFinite(Number(item.delayMs)) ? Math.max(0, Math.round(Number(item.delayMs))) : undefined,
      runId: typeof item.runId === 'string' ? item.runId.slice(0, 120) : undefined,
      autoRunDaily: item.autoRunDaily === true,
      autoRunHour: Math.max(0, Math.min(23, Math.round(Number(item.autoRunHour) || 0))),
      autoSend: item.autoSend === true,
      queuePaused: item.queuePaused === true,
      queue: {
        total: safeCount(queue.total),
        actionable: safeCount(queue.actionable),
        eligible: safeCount(queue.eligible),
        dailyBlocked: safeCount(queue.dailyBlocked),
        manualBlocked: safeCount(queue.manualBlocked),
        sentToday: safeCount(queue.sentToday),
      },
      result: result ? {
        status: String(result.status ?? '').slice(0, 40),
        attempted: safeCount(result.attempted),
        sent: safeCount(result.sent),
        needsAttention: safeCount(result.needsAttention),
      } : undefined,
      vacancy: vacancy ? {
        key: String(vacancy.key ?? '').slice(0, 160),
        title: String(vacancy.title ?? '').slice(0, 240),
        company: String(vacancy.company ?? '').slice(0, 240),
        status: String(vacancy.status ?? '').slice(0, 40),
        gate: vacancy.gate === 'manual' || vacancy.gate === 'daily' ? vacancy.gate : undefined,
        blocked: vacancy.blocked === true,
      } : undefined,
    }];
  }).slice(-500);
}

export function analyzeHhAutomationDiagnostics(
  events: HhAutomationDiagnosticEvent[],
): HhAutomationDiagnosticFinding[] {
  const findings: HhAutomationDiagnosticFinding[] = [];
  const fired = events.filter((event) => event.kind === 'timer_fired');
  const storedLocalHour = (event: HhAutomationDiagnosticEvent): number | null => {
    const match = event.localAt.match(/T(\d{2}):/);
    const hour = Number(match?.[1]);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  };
  const queueOutsideDailyHour = fired.find((event) => (
    event.source === 'queue_resume'
    && storedLocalHour(event) !== event.autoRunHour
  ));
  if (queueOutsideDailyHour) {
    findings.push({
      severity: 'info',
      code: 'QUEUE_RESUME_OUTSIDE_DAILY_HOUR',
      message: `Очередь продолжилась в ${queueOutsideDailyHour.localAt}, независимо от ежедневного поиска в ${String(queueOutsideDailyHour.autoRunHour).padStart(2, '0')}:00. Причина: ${queueOutsideDailyHour.reason}.`,
      eventId: queueOutsideDailyHour.id,
    });
  }
  for (const event of fired) {
    if (!event.scheduledFor) continue;
    const lateByMs = new Date(event.at).getTime() - new Date(event.scheduledFor).getTime();
    if (lateByMs > 5 * 60_000) {
      findings.push({
        severity: 'warning',
        code: 'TIMER_FIRED_LATE',
        message: `Таймер ${event.source} сработал с опозданием ${Math.round(lateByMs / 60_000)} мин. Обычно это означает сон Windows, выключенный компьютер или блокировку event loop.`,
        eventId: event.id,
      });
    }
  }
  const emptyRuns = events.filter((event) => (
    event.kind === 'run_finished'
    && event.result?.attempted === 0
    && event.queue.actionable > 0
  ));
  if (emptyRuns.length > 0) {
    const latest = emptyRuns.at(-1)!;
    findings.push({
      severity: 'warning',
      code: 'ACTIONABLE_BUT_NOT_ATTEMPTED',
      message: `В очереди было ${latest.queue.actionable}, но запуск не попытался обработать ни одной. Проверьте daily/manual gates, паузу и авторизацию HH.`,
      eventId: latest.id,
    });
  }
  const latestBlocker = [...events].reverse().find((event) => (
    event.kind === 'vacancy_finished' && event.vacancy?.blocked
  ));
  if (latestBlocker?.vacancy) {
    findings.push({
      severity: 'warning',
      code: 'QUEUE_STOPPED_BY_VACANCY',
      message: `Очередь остановилась на «${latestBlocker.vacancy.title}» (${latestBlocker.vacancy.company}): ${latestBlocker.reason}`,
      eventId: latestBlocker.id,
    });
  }
  if (events.length === 0) {
    findings.push({
      severity: 'info',
      code: 'NO_TIMELINE_YET',
      message: 'Диагностическая хронология ещё пуста. Она начнёт заполняться после запуска этой версии SkillCue.',
    });
  }
  return findings;
}

export function summarizeHhAutomationCoverage(
  events: readonly HhAutomationDiagnosticEvent[],
): HhAutomationCoverageSummary {
  const runs = events.filter((event) => event.kind === 'run_finished' && event.result);
  return {
    runs: runs.length,
    attempted: runs.reduce((total, event) => total + (event.result?.attempted ?? 0), 0),
    sent: runs.reduce((total, event) => total + (event.result?.sent ?? 0), 0),
    needsAttention: runs.reduce((total, event) => total + (event.result?.needsAttention ?? 0), 0),
    transientRetries: events.filter((event) => (
      event.kind === 'vacancy_finished' && event.vacancy?.gate === 'daily'
    )).length,
  };
}
