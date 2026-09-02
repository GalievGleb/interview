import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SCREEN_TASK_STATE_CHARS,
  MAX_SCREEN_TASK_STATE_TTL_MS,
  ScreenTaskStateMemory,
  parseOpaqueScreenTaskState,
  resolveStructuredScreenAssistEnabled,
} from './screenTaskStateMemory';

function taskState(updatedAtMs: number, expiresAtMs: number): string {
  return JSON.stringify({
    version: 1,
    task_kind: 'code',
    response_kind: 'code_solution',
    correction_mode: 'accumulate',
    requirements: { objective: 'Solve the visible task' },
    frames: [],
    ledger: [],
    ttl: {
      created_at_ms: updatedAtMs - 1_000,
      updated_at_ms: updatedAtMs,
      expires_at_ms: expiresAtMs,
    },
  });
}

describe('resolveStructuredScreenAssistEnabled', () => {
  it('enables the accepted structured pipeline only in Alpha', () => {
    expect(resolveStructuredScreenAssistEnabled('alphabuild', true)).toBe(true);
  });

  it.each(['development', 'devbuild', 'production', 'stable', 'test', '', 'DEVBUILD']) (
    'keeps structured screen disabled outside Alpha in %s',
    (mode) => {
      expect(resolveStructuredScreenAssistEnabled(mode, true)).toBe(false);
    },
  );

  it('keeps Alpha disabled before rollout acceptance', () => {
    expect(resolveStructuredScreenAssistEnabled('alphabuild', false)).toBe(false);
  });

});

describe('parseOpaqueScreenTaskState', () => {
  it('accepts a bounded unexpired server state without exposing its internals', () => {
    const now = 10_000;
    const raw = taskState(now, now + 60_000);

    expect(parseOpaqueScreenTaskState(raw, now)).toEqual({
      value: raw,
      expiresAtMs: now + 60_000,
    });
  });

  it.each([
    ['non-string', { ttl: { expires_at_ms: 20_000 } }],
    ['malformed JSON', '{bad-json'],
    ['missing ttl', '{"version":1}'],
    ['incomplete backend envelope', JSON.stringify({
      version: 1,
      ttl: { created_at_ms: 9_000, updated_at_ms: 10_000, expires_at_ms: 20_000 },
    })],
    ['unsupported version', taskState(10_000, 20_000).replace('"version":1', '"version":2')],
    ['invalid task kind', taskState(10_000, 20_000).replace('"code"', '"unknown"')],
    ['invalid response kind', taskState(10_000, 20_000).replace('"code_solution"', '"unknown"')],
    ['invalid correction mode', taskState(10_000, 20_000).replace('"accumulate"', '"unknown"')],
    ['non-object requirements', taskState(10_000, 20_000).replace(
      '"requirements":{"objective":"Solve the visible task"}',
      '"requirements":[]',
    )],
    ['missing requirements objective', taskState(10_000, 20_000).replace(
      '"requirements":{"objective":"Solve the visible task"}',
      '"requirements":{}',
    )],
    ['empty requirements objective', taskState(10_000, 20_000).replace(
      'Solve the visible task',
      '',
    )],
    ['non-array frames', taskState(10_000, 20_000).replace('"frames":[]', '"frames":{}')],
    ['non-array ledger', taskState(10_000, 20_000).replace('"ledger":[]', '"ledger":{}')],
    ['created after updated', taskState(10_000, 20_000).replace('"created_at_ms":9000', '"created_at_ms":11000')],
    ['expiry before updated', taskState(12_000, 11_000)],
    ['binary data URL', taskState(10_000, 20_000).replace(
      'Solve the visible task',
      'data:image/jpeg;base64,QUJD',
    )],
    ['expired', taskState(10_000, 10_000)],
    ['server TTL over two hours', taskState(10_000, 10_000 + MAX_SCREEN_TASK_STATE_TTL_MS + 1)],
    ['future expiry over two hours from the client', taskState(20_000, 10_000 + MAX_SCREEN_TASK_STATE_TTL_MS + 1)],
    ['oversized', 'x'.repeat(MAX_SCREEN_TASK_STATE_CHARS + 1)],
  ])('rejects %s state', (_case, raw) => {
    expect(parseOpaqueScreenTaskState(raw, 10_000)).toBeNull();
  });

  it('accepts the exact two-hour server TTL but rejects it at the expiry instant', () => {
    const now = 10_000;
    const raw = taskState(now, now + MAX_SCREEN_TASK_STATE_TTL_MS);

    expect(parseOpaqueScreenTaskState(raw, now)?.value).toBe(raw);
    expect(parseOpaqueScreenTaskState(raw, now + MAX_SCREEN_TASK_STATE_TTL_MS)).toBeNull();
  });
});

describe('ScreenTaskStateMemory', () => {
  afterEach(() => vi.useRealTimers());

  it('publishes a state only for the request generation that produced it', () => {
    const now = 10_000;
    const memory = new ScreenTaskStateMemory(() => now);
    const first = memory.beginRequest('new');
    const second = memory.beginRequest('new');
    const secondState = taskState(now, now + 60_000);

    expect(memory.commit(first.generation, taskState(now, now + 30_000))).toBe(false);
    expect(memory.commit(second.generation, secondState)).toBe(true);
    expect(memory.current()).toBe(secondState);
  });

  it('preserves the last good state across failed, cancelled and invalid replacements', () => {
    const now = 10_000;
    const memory = new ScreenTaskStateMemory(() => now);
    const initial = memory.beginRequest('new');
    const good = taskState(now, now + 60_000);
    expect(memory.commit(initial.generation, good)).toBe(true);

    const failed = memory.beginRequest('continue');
    memory.invalidatePending(failed.generation);
    expect(memory.commit(failed.generation, taskState(now, now + 90_000))).toBe(false);
    expect(memory.current()).toBe(good);

    const invalid = memory.beginRequest('continue');
    expect(memory.commit(invalid.generation, '{bad-json')).toBe(false);
    expect(memory.current()).toBe(good);
  });

  it('derives new versus continue without ever persisting the state', () => {
    const now = 10_000;
    const memory = new ScreenTaskStateMemory(() => now);
    expect(memory.beginRequest('continue')).toMatchObject({
      taskAction: 'new',
      taskState: undefined,
    });

    const request = memory.beginRequest('new');
    const state = taskState(now, now + 60_000);
    expect(memory.commit(request.generation, state)).toBe(true);
    expect(memory.beginRequest('continue')).toMatchObject({ taskAction: 'continue', taskState: state });
  });

  it('starts an explicit new task without carrying the prior committed state', () => {
    const now = 10_000;
    const memory = new ScreenTaskStateMemory(() => now);
    const first = memory.beginRequest('new');
    const state = taskState(now, now + 60_000);
    expect(memory.commit(first.generation, state)).toBe(true);

    expect(memory.beginRequest('new')).toMatchObject({
      taskAction: 'new',
      taskState: undefined,
    });
    expect(memory.current()).toBeUndefined();
  });

  it('drops the retained state at the server expiry deadline without another read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const memory = new ScreenTaskStateMemory();
    const request = memory.beginRequest('new');
    expect(memory.commit(request.generation, taskState(10_000, 20_000))).toBe(true);

    vi.advanceTimersByTime(10_000);

    expect(memory.current()).toBeUndefined();
    expect(memory.beginRequest('continue')).toMatchObject({ taskAction: 'new', taskState: undefined });
  });

  it('explicit reset invalidates pending work and clears committed state', () => {
    const now = 10_000;
    const memory = new ScreenTaskStateMemory(() => now);
    const first = memory.beginRequest('new');
    expect(memory.commit(first.generation, taskState(now, now + 60_000))).toBe(true);
    const pending = memory.beginRequest('continue');

    memory.reset();

    expect(memory.current()).toBeUndefined();
    expect(memory.commit(pending.generation, taskState(now, now + 90_000))).toBe(false);
  });
});
