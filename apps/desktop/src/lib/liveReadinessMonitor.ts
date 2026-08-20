import type { InterviewCalendarEvent } from '../types/electron';

const BEFORE_INTERVIEW_MS = 45 * 60_000;
const FAILURE_DEDUPE_MS = 6 * 60 * 60_000;

export interface ReadinessFailureNotice {
  code: string;
  notifiedAt: string;
}

export function liveReadinessDelayMs(
  events: readonly InterviewCalendarEvent[],
  now: Date = new Date(),
): number | null {
  const nowMs = now.getTime();
  const nearest = events
    .filter((item) => item.status !== 'cancelled' && !item.completedAt && new Date(item.startAt).getTime() >= nowMs)
    .map((item) => new Date(item.startAt).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  if (nearest == null) return null;
  return Math.max(0, nearest - BEFORE_INTERVIEW_MS - nowMs);
}

export function shouldNotifyReadinessFailure(
  previous: ReadinessFailureNotice | null,
  code: string,
  now: Date = new Date(),
): boolean {
  if (!previous || previous.code !== code) return true;
  const previousAt = new Date(previous.notifiedAt).getTime();
  return !Number.isFinite(previousAt) || now.getTime() - previousAt >= FAILURE_DEDUPE_MS;
}
