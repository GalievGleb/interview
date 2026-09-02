import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PREVIOUS_SCREEN_FRAME_CHARS,
  ScreenFrameMemory,
  SCREEN_FRAME_MEMORY_TTL_MS,
} from './screenFrameMemory';
import { presentScreenRequestTerminal } from './screenRequestCoordinator';

describe('ScreenFrameMemory', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps the two distinct previous JPEGs in capture order', () => {
    const memory = new ScreenFrameMemory(() => 1_000);

    memory.remember('data:image/jpeg;base64,first');
    memory.remember('data:image/jpeg;base64,first');
    memory.remember('data:image/jpeg;base64,second');
    memory.remember('data:image/jpeg;base64,third');

    expect(memory.previousFramesFor('data:image/jpeg;base64,current')).toEqual([
      'data:image/jpeg;base64,second',
      'data:image/jpeg;base64,third',
    ]);
    expect(memory.previousFramesFor('data:image/jpeg;base64,third')).toEqual([
      'data:image/jpeg;base64,second',
    ]);
  });

  it('expires memory after three minutes and clears it for a new task', () => {
    let now = 1_000;
    const memory = new ScreenFrameMemory(() => now);
    memory.remember('data:image/jpeg;base64,first');
    memory.setPriorSolutionSummary('first solution');

    now += SCREEN_FRAME_MEMORY_TTL_MS + 1;
    expect(memory.previousFramesFor('data:image/jpeg;base64,current')).toEqual([]);
    expect(memory.priorSolutionSummary()).toBeUndefined();

    memory.remember('data:image/jpeg;base64,next');
    memory.setPriorSolutionSummary('next solution');
    memory.clear();
    expect(memory.previousFramesFor('data:image/jpeg;base64,current')).toEqual([]);
    expect(memory.priorSolutionSummary()).toBeUndefined();
  });

  it('bounds the aggregate previous-image payload without dropping the current frame', () => {
    const memory = new ScreenFrameMemory(() => 1_000);
    const frameChars = Math.ceil(MAX_PREVIOUS_SCREEN_FRAME_CHARS / 2) + 100;
    const old = `data:image/jpeg;base64,${'a'.repeat(frameChars)}`;
    const recent = `data:image/jpeg;base64,${'b'.repeat(frameChars)}`;
    memory.remember(old);
    memory.remember(recent);

    const previous = memory.previousFramesFor('data:image/jpeg;base64,current');
    expect(previous).toEqual([recent]);
    expect(previous.reduce((total, image) => total + image.length, 0))
      .toBeLessThanOrEqual(MAX_PREVIOUS_SCREEN_FRAME_CHARS);
  });

  it('expires each frame from its own capture time despite later capture and summary activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'));
    const memory = new ScreenFrameMemory();
    memory.remember('data:image/jpeg;base64,older');

    vi.advanceTimersByTime(SCREEN_FRAME_MEMORY_TTL_MS - 1_000);
    memory.remember('data:image/jpeg;base64,recent');
    memory.setPriorSolutionSummary('recent answer');
    vi.advanceTimersByTime(1_000);

    expect(memory.previousFramesFor('data:image/jpeg;base64,current')).toEqual([
      'data:image/jpeg;base64,recent',
    ]);
    expect(memory.priorSolutionSummary()).toBe('recent answer');
  });

  it('releases retained JPEG references at the TTL deadline without another read', () => {
    vi.useFakeTimers();
    const memory = new ScreenFrameMemory();
    memory.remember('data:image/jpeg;base64,sensitive-pixels');

    vi.advanceTimersByTime(SCREEN_FRAME_MEMORY_TTL_MS);

    expect(memory.retainedFrameCount()).toBe(0);
  });

  it('does not publish a staged frame when partial output ends in an error', () => {
    const memory = new ScreenFrameMemory(() => 1_000);
    const staged = memory.stage('data:image/jpeg;base64,failed-frame');
    const terminal = presentScreenRequestTerminal({
      status: 'error',
      answer: '```sql\nSELECT partial',
      reason: 'stream_error',
      message: 'Ответ обрезан. Это неполное решение — повторите запрос.',
    });

    expect(staged.previousFrames).toEqual([]);
    staged.settle(terminal.complete);

    expect(memory.retainedFrameCount()).toBe(0);
    expect(memory.previousFramesFor('data:image/jpeg;base64,next-frame')).toEqual([]);
  });

  it('publishes a successful staged frame exactly once for the next request', () => {
    const memory = new ScreenFrameMemory(() => 1_000);
    const staged = memory.stage('data:image/jpeg;base64,completed-frame');
    const terminal = presentScreenRequestTerminal({
      status: 'done',
      answer: 'Полное решение',
    });

    staged.settle(terminal.complete);
    staged.settle(terminal.complete);

    expect(memory.retainedFrameCount()).toBe(1);
    expect(memory.previousFramesFor('data:image/jpeg;base64,next-frame')).toEqual([
      'data:image/jpeg;base64,completed-frame',
    ]);
  });

  it('does not let a late successful terminal resurrect pixels after clear', () => {
    const memory = new ScreenFrameMemory(() => 1_000);
    const staged = memory.stage('data:image/jpeg;base64,old-task-frame');

    memory.clear();
    staged.settle(true);

    expect(memory.retainedFrameCount()).toBe(0);
    expect(memory.previousFramesFor('data:image/jpeg;base64,new-task-frame')).toEqual([]);
  });

  it('keeps the staged frame TTL anchored to capture instead of model completion', () => {
    let now = 1_000;
    const memory = new ScreenFrameMemory(() => now);
    const staged = memory.stage('data:image/jpeg;base64,slow-response-frame');

    now += SCREEN_FRAME_MEMORY_TTL_MS;
    staged.settle(true);

    expect(memory.retainedFrameCount()).toBe(0);
    expect(memory.previousFramesFor('data:image/jpeg;base64,next-frame')).toEqual([]);
  });
});
