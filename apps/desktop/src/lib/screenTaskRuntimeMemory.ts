import { ScreenFrameMemory } from './screenFrameMemory';
import type { PreviousScreenTask } from './screenTaskContinuity';
import { ScreenTaskStateMemory } from './screenTaskStateMemory';

/** Owns every transient, sensitive renderer value for one screen-task epoch. */
export class ScreenTaskRuntimeMemory {
  readonly frames: ScreenFrameMemory;
  readonly state: ScreenTaskStateMemory;
  lastTask: PreviousScreenTask | null = null;

  constructor(now: () => number = () => Date.now()) {
    this.frames = new ScreenFrameMemory(now);
    this.state = new ScreenTaskStateMemory(now);
  }

  reset(): void {
    this.frames.clear();
    this.state.reset();
    this.lastTask = null;
  }

  settleFailure(generation: number, errorCode?: string): void {
    if (errorCode === 'screen_task_state_expired') {
      this.reset();
      return;
    }
    this.state.invalidatePending(generation);
  }

  /** Legacy fallback may keep visual continuity, but must never retain uncommitted typed state. */
  settleLegacyFallback(generation: number): void {
    this.state.invalidatePending(generation);
    this.state.reset();
  }
}
