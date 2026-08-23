import { describe, expect, it } from 'vitest';
import {
  formatHomeDate,
  formatHomeInterviewBadge,
  formatHomeInterviewStart,
  getHomeApplicationFlow,
  getHomeHhCommand,
  isInterviewStartingSoon,
  isSameLocalDay,
} from './homeRadar';

describe('home radar date labels', () => {
  const now = new Date(2026, 7, 9, 18, 0, 0);

  it('never labels a tomorrow interview as today', () => {
    const tomorrow = new Date(2026, 7, 10, 11, 0, 0).toISOString();
    expect(formatHomeInterviewBadge(tomorrow, now)).toBe('ЗАВТРА · 11:00');
    expect(formatHomeInterviewStart(tomorrow, now)).toBe('завтра в 11:00');
    expect(isSameLocalDay(tomorrow, now)).toBe(false);
  });

  it('uses one consistent today label for the event badge and sentence', () => {
    const today = new Date(2026, 7, 9, 20, 30, 0).toISOString();
    expect(formatHomeInterviewBadge(today, now)).toBe('СЕГОДНЯ · 20:30');
    expect(formatHomeInterviewStart(today, now)).toBe('сегодня в 20:30');
    expect(isSameLocalDay(today, now)).toBe(true);
  });

  it('formats the dashboard date independently from event relativity', () => {
    expect(formatHomeDate(now)).toBe('Воскресенье, 9 августа');
  });
});

describe('home application flow visual', () => {
  it('makes employer questions the single primary action before another HH run', () => {
    expect(getHomeHhCommand({
      running: false,
      queued: 7,
      pendingQuestions: 2,
      loginRequired: false,
      persistentVerification: false,
    })).toEqual({
      eyebrow: 'ТРЕБУЕТСЯ ОТВЕТ',
      title: 'Ответьте на 2 вопроса работодателей',
      action: 'screening',
      actionLabel: 'Открыть вопросы',
    });
  });

  it('promotes an interview only during the two-hour readiness window', () => {
    const now = new Date('2026-08-23T10:00:00+07:00');
    expect(isInterviewStartingSoon('2026-08-23T11:59:00+07:00', now)).toBe(true);
    expect(isInterviewStartingSoon('2026-08-23T12:01:00+07:00', now)).toBe(false);
  });

  it('keeps the route dormant before search starts', () => {
    expect(getHomeApplicationFlow({ queued: 0, sentToday: 0, activeDialogs: 0, running: false }))
      .toEqual({ progress: 0, reached: [false, false, false] });
  });

  it('moves through queue, sent applications, and HR dialogs without losing prior stages', () => {
    expect(getHomeApplicationFlow({ queued: 12, sentToday: 0, activeDialogs: 0, running: true }))
      .toEqual({ progress: 8, reached: [true, false, false] });
    expect(getHomeApplicationFlow({ queued: 0, sentToday: 4, activeDialogs: 0, running: false }))
      .toEqual({ progress: 50, reached: [true, true, false] });
    expect(getHomeApplicationFlow({ queued: 0, sentToday: 0, activeDialogs: 2, running: false }))
      .toEqual({ progress: 100, reached: [true, true, true] });
  });
});
