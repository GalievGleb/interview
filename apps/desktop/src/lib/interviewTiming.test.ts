import { describe, expect, it } from 'vitest';
import type { InterviewCalendarEvent } from '../types/electron';
import {
  hasCredibleInterviewCompletion,
  isCompletedInterview,
  isUpcomingInterview,
} from './interviewTiming';

const now = new Date('2026-08-09T11:30:00.000Z');

function event(overrides: Partial<InterviewCalendarEvent> = {}): InterviewCalendarEvent {
  return {
    id: 'tomorrow-call',
    vacancyTitle: 'QA AUTO',
    companyName: 'MTC',
    type: 'technical',
    status: 'confirmed',
    startAt: '2026-08-10T04:00:00.000Z',
    endAt: '2026-08-10T05:00:00.000Z',
    source: 'manual',
    createdAt: '2026-08-09T10:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('interview timing status', () => {
  it('keeps a future interview visible when a practice session completed much too early', () => {
    const scheduled = event({
      sessionId: 'practice-session',
      completedAt: '2026-08-09T11:22:00.635Z',
      outcome: {
        sessionId: 'practice-session',
        headline: 'Проверка оверлея',
        facts: [],
        conditions: [],
        nextSteps: [],
        openQuestions: [],
        createdAt: '2026-08-09T11:22:00.635Z',
      },
    });

    expect(hasCredibleInterviewCompletion(scheduled)).toBe(false);
    expect(isUpcomingInterview(scheduled, now)).toBe(true);
    expect(isCompletedInterview(scheduled, now)).toBe(false);
  });

  it('accepts an outcome recorded shortly before the scheduled start', () => {
    const scheduled = event({ completedAt: '2026-08-10T03:30:00.000Z' });
    expect(hasCredibleInterviewCompletion(scheduled)).toBe(true);
    expect(isUpcomingInterview(scheduled, now)).toBe(false);
    expect(isCompletedInterview(scheduled, now)).toBe(true);
  });

  it('moves an ordinary elapsed event to history', () => {
    const elapsed = event({
      startAt: '2026-08-09T09:00:00.000Z',
      endAt: '2026-08-09T10:00:00.000Z',
    });
    expect(isUpcomingInterview(elapsed, now)).toBe(false);
    expect(isCompletedInterview(elapsed, now)).toBe(true);
  });
});
