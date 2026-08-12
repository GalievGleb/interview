import type { InterviewCalendarEvent } from '../types/electron';

const INTERVIEW_SESSION_EARLY_WINDOW_MS = 2 * 60 * 60 * 1000;

function completionTimestamp(event: InterviewCalendarEvent): number | null {
  const value = event.completedAt ?? event.outcome?.createdAt;
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * A practice overlay session can accidentally carry an outcome while the real
 * interview is still many hours away. Such an outcome is not completion of the
 * scheduled event and must not hide it from Home or Calendar.
 */
export function hasCredibleInterviewCompletion(event: InterviewCalendarEvent): boolean {
  if (!event.completedAt && !event.outcome) return false;
  const completedAt = completionTimestamp(event);
  const startAt = Date.parse(event.startAt);
  if (completedAt === null || !Number.isFinite(startAt)) return true;
  return completedAt >= startAt - INTERVIEW_SESSION_EARLY_WINDOW_MS;
}

export function isUpcomingInterview(event: InterviewCalendarEvent, now = new Date()): boolean {
  if (event.status === 'cancelled' || hasCredibleInterviewCompletion(event)) return false;
  const endAt = Date.parse(event.endAt);
  return Number.isFinite(endAt) && endAt >= now.getTime();
}

export function isCompletedInterview(event: InterviewCalendarEvent, now = new Date()): boolean {
  if (event.status === 'cancelled') return false;
  if (hasCredibleInterviewCompletion(event)) return true;
  const endAt = Date.parse(event.endAt);
  return Number.isFinite(endAt) && endAt < now.getTime();
}
