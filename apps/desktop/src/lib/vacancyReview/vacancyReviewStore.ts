/**
 * Local persistence for Vacancy Smoke Review sessions (no backend required).
 * Swap for a backend store later without touching the UI — same accessors.
 */
import type { SmokeReviewSession } from './types';

const KEY = 'skillcue.vacancyReview.sessions.v1';
const MAX_SESSIONS = 25;

function readAll(): SmokeReviewSession[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SmokeReviewSession[]) : [];
  } catch {
    return [];
  }
}

function writeAll(sessions: SmokeReviewSession[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

export function saveSession(session: SmokeReviewSession): void {
  const all = readAll().filter((s) => s.id !== session.id);
  all.unshift(session);
  writeAll(all);
}

export function listSessions(): SmokeReviewSession[] {
  return readAll().sort((a, b) => b.startedAt - a.startedAt);
}

export function getSession(id: string): SmokeReviewSession | null {
  return readAll().find((s) => s.id === id) ?? null;
}

export function deleteSession(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
}

export function latestInProgress(): SmokeReviewSession | null {
  return listSessions().find((s) => s.status === 'in_progress') ?? null;
}

export function latestCompleted(): SmokeReviewSession | null {
  return listSessions().find((s) => s.status === 'completed') ?? null;
}
