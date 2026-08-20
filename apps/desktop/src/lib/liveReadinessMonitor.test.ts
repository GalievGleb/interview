import { describe, expect, it } from 'vitest';
import type { InterviewCalendarEvent } from '../types/electron';
import { liveReadinessDelayMs, shouldNotifyReadinessFailure } from './liveReadinessMonitor';

function event(startAt: string, status: InterviewCalendarEvent['status'] = 'confirmed'): InterviewCalendarEvent {
  return {
    id: startAt, vacancyTitle: 'QA', companyName: 'SkillCue', type: 'technical',
    status, startAt, endAt: new Date(new Date(startAt).getTime() + 30 * 60_000).toISOString(),
    source: 'manual', meetingUrl: '', notes: '', createdAt: startAt, updatedAt: startAt,
  };
}

describe('silent live readiness scheduling', () => {
  it('checks 45 minutes before the nearest confirmed interview', () => {
    const now = new Date('2026-08-20T10:00:00.000Z');
    expect(liveReadinessDelayMs([event('2026-08-20T12:00:00.000Z')], now)).toBe(75 * 60_000);
  });

  it('checks immediately when an interview starts within 45 minutes', () => {
    const now = new Date('2026-08-20T10:00:00.000Z');
    expect(liveReadinessDelayMs([event('2026-08-20T10:30:00.000Z')], now)).toBe(0);
  });

  it('ignores completed and past interviews', () => {
    const now = new Date('2026-08-20T10:00:00.000Z');
    expect(liveReadinessDelayMs([
      event('2026-08-20T09:00:00.000Z'),
      event('2026-08-20T12:00:00.000Z', 'cancelled'),
    ], now)).toBeNull();
  });

  it('deduplicates the same readiness failure for six hours', () => {
    const now = new Date('2026-08-20T10:00:00.000Z');
    expect(shouldNotifyReadinessFailure(null, 'provider_unavailable', now)).toBe(true);
    expect(shouldNotifyReadinessFailure(
      { code: 'provider_unavailable', notifiedAt: '2026-08-20T09:00:00.000Z' },
      'provider_unavailable', now,
    )).toBe(false);
    expect(shouldNotifyReadinessFailure(
      { code: 'provider_unavailable', notifiedAt: '2026-08-20T03:00:00.000Z' },
      'provider_unavailable', now,
    )).toBe(true);
  });
});
