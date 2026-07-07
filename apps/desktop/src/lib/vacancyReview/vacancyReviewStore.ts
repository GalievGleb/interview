/**
 * Persistence for Vacancy Smoke Review sessions.
 *
 * localStorage stays the *synchronous read cache* (the UI reads it in useState
 * initializers), while the backend SQLite table is the durable source of truth:
 * every save/delete is mirrored to the API (fire-and-forget, offline-tolerant)
 * and `syncMockSessionsFromBackend()` reconciles both sides on launch. Pages
 * listen for the `skillcue:mock-sessions-synced` event to re-read.
 */
import { api } from '../api';
import { markMilestone } from '../activation';
import type { SmokeReviewSession } from './types';

const KEY = 'skillcue.vacancyReview.sessions.v1';
// Надгробия удалённых id: без них reconcile тянул удалённую-в-офлайне сессию
// обратно с сервера (delete не дошёл) — и она «воскресала» при следующем старте.
const TOMBSTONE_KEY = 'skillcue.vacancyReview.deleted.v1';
const MAX_SESSIONS = 25;
const MAX_TOMBSTONES = 200;

export const MOCK_SESSIONS_SYNCED_EVENT = 'skillcue:mock-sessions-synced';

type StoredSession = SmokeReviewSession & { updatedAt?: number };

function readAll(): StoredSession[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredSession[]) : [];
  } catch {
    return [];
  }
}

function readTombstones(): string[] {
  try {
    const raw = localStorage.getItem(TOMBSTONE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function addTombstone(id: string): void {
  try {
    const next = [id, ...readTombstones().filter((x) => x !== id)].slice(0, MAX_TOMBSTONES);
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(next));
  } catch {
    /* storage full — worst case a rare resurrect, not a crash */
  }
}

function writeAll(sessions: StoredSession[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

function mirrorUpsert(session: StoredSession): void {
  void api
    .upsertMockSession({
      id: session.id,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt ?? Date.now(),
      payload: session as unknown as Record<string, unknown>,
    })
    .catch(() => {
      /* backend offline — the launch reconcile will push it later */
    });
}

export function saveSession(session: SmokeReviewSession): void {
  const stamped: StoredSession = { ...session, updatedAt: Date.now() };
  const all = readAll().filter((s) => s.id !== session.id);
  all.unshift(stamped);
  writeAll(all);
  // Вехи активации: любая сохранённая сессия = вакансия разобрана; статус
  // completed = mock пройден. markMilestone фиксирует только первое прохождение.
  markMilestone('vacancyAnalyzed');
  if (session.status === 'completed') markMilestone('mockCompleted');
  // Пересохранение ранее удалённого id (тот же id снова в работе) снимает надгробие.
  const tombstones = readTombstones();
  if (tombstones.includes(session.id)) {
    try {
      localStorage.setItem(
        TOMBSTONE_KEY,
        JSON.stringify(tombstones.filter((x) => x !== session.id)),
      );
    } catch {
      /* non-fatal */
    }
  }
  mirrorUpsert(stamped);
}

export function listSessions(): SmokeReviewSession[] {
  return readAll().sort((a, b) => b.startedAt - a.startedAt);
}

export function getSession(id: string): SmokeReviewSession | null {
  return readAll().find((s) => s.id === id) ?? null;
}

export function deleteSession(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
  // Надгробие ставим ДО remote-delete: если бэкенд офлайн, reconcile при
  // следующем старте не должен тянуть эту сессию обратно с сервера.
  addTombstone(id);
  void api.deleteMockSessionRemote(id).catch(() => {
    /* backend offline — надгробие не даст сессии воскреснуть; повторный
       remote-delete уйдёт из syncMockSessionsFromBackend, пока строка жива. */
  });
}

export function latestInProgress(): SmokeReviewSession | null {
  return listSessions().find((s) => s.status === 'in_progress') ?? null;
}

export function latestCompleted(): SmokeReviewSession | null {
  return listSessions().find((s) => s.status === 'completed') ?? null;
}

let syncedOnce = false;

/**
 * Reconcile localStorage with the backend once per app run:
 * push local sessions the backend doesn't have (or has older), pull remote
 * sessions missing locally (recovers after profile cleanup / another machine).
 */
export async function syncMockSessionsFromBackend(): Promise<void> {
  if (syncedOnce) return;
  let remote;
  try {
    remote = (await api.listMockSessions()).sessions;
  } catch {
    return; // backend not up yet — try again next launch
  }
  syncedOnce = true;

  const local = readAll();
  const localById = new Map(local.map((s) => [s.id, s]));
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const tombstoned = new Set(readTombstones());

  // Push: local newer or missing remotely.
  for (const s of local) {
    const r = remoteById.get(s.id);
    const localStamp = s.updatedAt ?? s.startedAt;
    if (!r || localStamp > (r.updatedAt || 0)) {
      mirrorUpsert(s);
    }
  }

  // Добиваем remote-delete для удалённых в офлайне сессий, которые ещё живы
  // на сервере (первый delete не дошёл) — иначе строка висела бы вечно.
  for (const r of remote) {
    if (tombstoned.has(r.id)) {
      void api.deleteMockSessionRemote(r.id).catch(() => {});
    }
  }

  // Pull: remote sessions we don't have locally (payload IS the session).
  // Надгробленные пропускаем — пользователь их удалил, воскрешать нельзя.
  let changed = false;
  for (const r of remote) {
    if (!localById.has(r.id) && !tombstoned.has(r.id)) {
      const session = r.payload as unknown as StoredSession;
      if (session && typeof session.id === 'string') {
        local.push(session);
        changed = true;
      }
    }
  }

  if (changed) {
    local.sort((a, b) => b.startedAt - a.startedAt);
    writeAll(local);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(MOCK_SESSIONS_SYNCED_EVENT));
    }
  }
}
