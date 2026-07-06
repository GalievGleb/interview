import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmokeReviewSession } from './types';

// Мокаем API-слой: стор дёргает upsert/list/delete как fire-and-forget.
const remoteRows: Array<{ id: string; updatedAt: number; payload: unknown }> = [];
const deleteSpy = vi.fn(async (_id: string) => ({ deleted: _id }));

vi.mock('../api', () => ({
  api: {
    upsertMockSession: vi.fn(async () => ({ saved: 'ok' })),
    listMockSessions: vi.fn(async () => ({ sessions: remoteRows })),
    deleteMockSessionRemote: (id: string) => deleteSpy(id),
  },
}));

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

function makeSession(id: string): SmokeReviewSession {
  // Минимальная сессия: стор трогает только id/status/startedAt/updatedAt.
  return {
    id,
    status: 'completed',
    startedAt: Date.now(),
    questions: [],
    answers: [],
  } as unknown as SmokeReviewSession;
}

describe('vacancyReviewStore tombstones', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
    // Стор шлёт событие синка через window — в node его нет, даём заглушку.
    Object.defineProperty(globalThis, 'window', {
      value: { dispatchEvent: vi.fn() },
      configurable: true,
    });
    localStorage.clear();
    remoteRows.length = 0;
    deleteSpy.mockClear();
    vi.resetModules();
  });

  it('deleted-while-offline session does NOT resurrect on reconcile', async () => {
    const store = await import('./vacancyReviewStore');
    const s = makeSession('sess-1');
    store.saveSession(s);
    // Бэкенд «имеет» эту сессию (remote-delete в офлайне не дошёл).
    remoteRows.push({ id: 'sess-1', updatedAt: Date.now(), payload: s });

    store.deleteSession('sess-1');
    expect(store.getSession('sess-1')).toBeNull();

    await store.syncMockSessionsFromBackend();

    // Главное: сессия не вернулась из remote.
    expect(store.getSession('sess-1')).toBeNull();
    expect(store.listSessions()).toHaveLength(0);
    // И reconcile добил remote-delete, раз строка ещё жива на сервере.
    expect(deleteSpy).toHaveBeenCalledWith('sess-1');
  });

  it('genuinely new remote session IS pulled in', async () => {
    const store = await import('./vacancyReviewStore');
    const remote = makeSession('remote-only');
    remoteRows.push({ id: 'remote-only', updatedAt: Date.now(), payload: remote });

    await store.syncMockSessionsFromBackend();

    expect(store.getSession('remote-only')).not.toBeNull();
  });

  it('re-saving a tombstoned id clears the tombstone', async () => {
    const store = await import('./vacancyReviewStore');
    store.saveSession(makeSession('sess-2'));
    store.deleteSession('sess-2');
    // Пользователь снова начал сессию с тем же id — надгробие должно сняться.
    store.saveSession(makeSession('sess-2'));
    remoteRows.push({ id: 'sess-2', updatedAt: Date.now(), payload: makeSession('sess-2') });

    // Удалим локально (симуляция чистки), но НЕ ставим tombstone заново вручную.
    // После снятия надгробия сохранением reconcile снова может её подтянуть.
    localStorage.setItem('skillcue.vacancyReview.sessions.v1', JSON.stringify([]));
    await store.syncMockSessionsFromBackend();

    expect(store.getSession('sess-2')).not.toBeNull();
  });
});
