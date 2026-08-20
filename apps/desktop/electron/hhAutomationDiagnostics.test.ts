import { describe, expect, it } from 'vitest';
import {
  analyzeHhAutomationDiagnostics,
  summarizeHhAutomationCoverage,
  normalizeHhAutomationDiagnostics,
  type HhAutomationDiagnosticEvent,
} from './hhAutomationDiagnostics';

function event(overrides: Partial<HhAutomationDiagnosticEvent> = {}): HhAutomationDiagnosticEvent {
  return {
    id: 'event-1',
    at: '2026-08-20T22:00:00.000Z',
    localAt: '2026-08-21T05:00:00.000+07:00',
    timezone: 'Asia/Krasnoyarsk',
    utcOffsetMinutes: 420,
    kind: 'timer_fired',
    source: 'queue_resume',
    reason: 'startup_restore',
    scheduledFor: '2026-08-20T22:00:00.000Z',
    localScheduledFor: '2026-08-21T05:00:00.000+07:00',
    delayMs: 10_000,
    autoRunDaily: true,
    autoRunHour: 10,
    autoSend: true,
    queuePaused: false,
    queue: {
      total: 20,
      actionable: 5,
      eligible: 5,
      dailyBlocked: 0,
      manualBlocked: 0,
      sentToday: 0,
    },
    ...overrides,
  };
}

describe('HH automation diagnostics', () => {
  it('explains that a 05:00 queue resume is independent from the 10:00 daily search', () => {
    const findings = analyzeHhAutomationDiagnostics([event()]);
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'QUEUE_RESUME_OUTSIDE_DAILY_HOUR',
    }));
    expect(findings[0]?.message).toContain('10:00');
    expect(findings[0]?.message).toContain('startup_restore');
  });

  it('detects a Windows sleep or blocked event loop from a late timer', () => {
    const findings = analyzeHhAutomationDiagnostics([event({
      at: '2026-08-20T23:15:00.000Z',
      localAt: '2026-08-21T06:15:00.000+07:00',
    })]);
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'TIMER_FIRED_LATE',
      severity: 'warning',
    }));
  });

  it('normalizes persisted history and drops malformed entries', () => {
    expect(normalizeHhAutomationDiagnostics([
      event(),
      { kind: 'timer_fired', source: 'queue_resume', at: 'broken' },
    ])).toHaveLength(1);
  });

  it('reports actionable queue items that a run did not attempt', () => {
    const findings = analyzeHhAutomationDiagnostics([event({
      kind: 'run_finished',
      source: 'daily_search',
      result: { status: 'attention', attempted: 0, sent: 0, needsAttention: 1 },
    })]);
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'ACTIONABLE_BUT_NOT_ATTEMPTED',
    }));
  });

  it('names the vacancy that hard-stopped the queue', () => {
    const findings = analyzeHhAutomationDiagnostics([event({
      kind: 'vacancy_finished',
      reason: 'HH потребовал ручное подтверждение формы.',
      vacancy: {
        key: 'hh:1',
        title: 'QA Automation Engineer',
        company: 'Example',
        status: 'opened',
        gate: 'manual',
        blocked: true,
      },
    })]);
    expect(findings).toContainEqual(expect.objectContaining({
      code: 'QUEUE_STOPPED_BY_VACANCY',
      message: expect.stringContaining('QA Automation Engineer'),
    }));
  });

  it('summarizes coverage with counts only and no vacancy content', () => {
    const summary = summarizeHhAutomationCoverage([
      event({ kind: 'run_finished', result: { status: 'completed', attempted: 9, sent: 5, needsAttention: 2 } }),
      event({ kind: 'vacancy_finished', reason: 'private answer', vacancy: {
        key: 'hh:secret', title: 'Secret title', company: 'Secret company', status: 'skipped', blocked: false,
      } }),
    ]);
    expect(summary).toEqual({ runs: 1, attempted: 9, sent: 5, needsAttention: 2, transientRetries: 0 });
    expect(JSON.stringify(summary)).not.toContain('Secret');
    expect(JSON.stringify(summary)).not.toContain('private answer');
  });
});
