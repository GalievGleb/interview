import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QueuedRendererSignal } from './queuedRendererSignal';

describe('QueuedRendererSignal', () => {
  it('keeps the sandboxed preload self-contained without relative requires', () => {
    const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8');

    expect(preload).not.toMatch(/from\s+['"]\.\//u);
  });

  it('replays one cold-start command exactly once after the renderer subscribes', () => {
    const ipc = new EventEmitter();
    const signal = new QueuedRendererSignal(ipc, 'overlay:candidate-follow-up');
    const received: string[] = [];

    ipc.emit('overlay:candidate-follow-up');
    const unsubscribe = signal.subscribe(() => received.push('first'));
    unsubscribe();
    const unsubscribeAgain = signal.subscribe(() => received.push('replay'));

    expect(received).toEqual(['first']);
    unsubscribeAgain();
  });

  it('delivers deliberate later presses individually while subscribed', () => {
    const ipc = new EventEmitter();
    const signal = new QueuedRendererSignal(ipc, 'overlay:candidate-follow-up');
    let received = 0;
    signal.subscribe(() => { received += 1; });

    ipc.emit('overlay:candidate-follow-up');
    ipc.emit('overlay:candidate-follow-up');

    expect(received).toBe(2);
  });

  it('bounds presses before readiness to one pending command', () => {
    const ipc = new EventEmitter();
    const signal = new QueuedRendererSignal(ipc, 'overlay:candidate-follow-up');
    let received = 0;

    ipc.emit('overlay:candidate-follow-up');
    ipc.emit('overlay:candidate-follow-up');
    signal.subscribe(() => { received += 1; });

    expect(received).toBe(1);
  });
});
