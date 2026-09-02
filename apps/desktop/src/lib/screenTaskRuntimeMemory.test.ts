import { describe, expect, it } from 'vitest';
import { ScreenTaskRuntimeMemory } from './screenTaskRuntimeMemory';

function taskState(now: number): string {
  return JSON.stringify({
    version: 1,
    task_kind: 'code',
    response_kind: 'code_solution',
    correction_mode: 'accumulate',
    requirements: { objective: 'Current task' },
    frames: [],
    ledger: [],
    ttl: {
      created_at_ms: now,
      updated_at_ms: now,
      expires_at_ms: now + 60_000,
    },
  });
}

describe('ScreenTaskRuntimeMemory', () => {
  it('atomically clears typed state, pixels, summary and the previous task', () => {
    const now = 10_000;
    const runtime = new ScreenTaskRuntimeMemory(() => now);
    runtime.frames.remember('data:image/jpeg;base64,QUJD');
    runtime.frames.setPriorSolutionSummary('prior answer');
    runtime.lastTask = { question: 'prior question', answer: 'prior answer' };
    const lease = runtime.state.beginRequest('new');
    expect(runtime.state.commit(lease.generation, taskState(now))).toBe(true);

    runtime.reset();

    expect(runtime.frames.retainedFrameCount()).toBe(0);
    expect(runtime.frames.priorSolutionSummary()).toBeUndefined();
    expect(runtime.state.current()).toBeUndefined();
    expect(runtime.lastTask).toBeNull();
    expect(runtime.state.commit(lease.generation, taskState(now))).toBe(false);
  });

  it('preserves last-good state after a generic failure but clears it after server expiry', () => {
    const now = 10_000;
    const runtime = new ScreenTaskRuntimeMemory(() => now);
    const first = runtime.state.beginRequest('new');
    const good = taskState(now);
    expect(runtime.state.commit(first.generation, good)).toBe(true);

    const genericFailure = runtime.state.beginRequest('continue');
    runtime.settleFailure(genericFailure.generation, 'provider_timeout');
    expect(runtime.state.current()).toBe(good);

    runtime.frames.remember('data:image/jpeg;base64,QUJD');
    runtime.lastTask = { question: 'old', answer: 'old' };
    const expired = runtime.state.beginRequest('continue');
    runtime.settleFailure(expired.generation, 'screen_task_state_expired');

    expect(runtime.state.current()).toBeUndefined();
    expect(runtime.frames.retainedFrameCount()).toBe(0);
    expect(runtime.lastTask).toBeNull();
  });

  it('drops only typed state when a validated pipeline delegates to legacy fallback', () => {
    const now = 10_000;
    const runtime = new ScreenTaskRuntimeMemory(() => now);
    runtime.frames.remember('data:image/jpeg;base64,QUJD');
    runtime.frames.setPriorSolutionSummary('prior answer');
    runtime.lastTask = { question: 'prior question', answer: 'prior answer' };
    const first = runtime.state.beginRequest('new');
    expect(runtime.state.commit(first.generation, taskState(now))).toBe(true);
    const unsupported = runtime.state.beginRequest('continue');

    runtime.settleLegacyFallback(unsupported.generation);

    expect(runtime.state.current()).toBeUndefined();
    expect(runtime.frames.retainedFrameCount()).toBe(1);
    expect(runtime.frames.priorSolutionSummary()).toBe('prior answer');
    expect(runtime.lastTask).toEqual({ question: 'prior question', answer: 'prior answer' });
  });
});
