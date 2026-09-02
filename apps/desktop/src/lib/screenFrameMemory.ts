import { clipPriorSolutionSummary } from './screenTaskContinuity';

export const MAX_PREVIOUS_SCREEN_FRAMES = 2;
export const MAX_PREVIOUS_SCREEN_FRAME_CHARS = 600_000;
export const SCREEN_FRAME_MEMORY_TTL_MS = 3 * 60 * 1_000;

interface ScreenFrame {
  image: string;
  capturedAtMs: number;
}

export interface StagedScreenFrame {
  /** Previously completed viewports; the staged current frame is excluded. */
  previousFrames: string[];
  /** Commits exactly once only when the owning request completed successfully. */
  settle(complete: boolean): void;
}

/** In-memory-only viewport context for one short screen task. */
export class ScreenFrameMemory {
  private frames: ScreenFrame[] = [];
  private summary: string | undefined;
  private summaryUpdatedAtMs = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Prepares one captured viewport without publishing it. This keeps failed,
   * cancelled and truncated requests out of the next request's frame context.
   */
  stage(image: string): StagedScreenFrame {
    const normalized = image.trim();
    const capturedAtMs = this.now();
    const epoch = this.epoch;
    const previousFrames = this.previousFramesFor(normalized);
    let settled = false;
    return {
      previousFrames,
      settle: (complete) => {
        if (settled) return;
        settled = true;
        if (
          complete
          && this.epoch === epoch
          && this.now() - capturedAtMs < SCREEN_FRAME_MEMORY_TTL_MS
        ) {
          this.rememberAt(normalized, capturedAtMs);
        }
      },
    };
  }

  remember(image: string): void {
    this.rememberAt(image, this.now());
  }

  private rememberAt(image: string, capturedAtMs: number): void {
    this.expire();
    const normalized = image.trim();
    if (!normalized) return;
    if (this.now() - capturedAtMs >= SCREEN_FRAME_MEMORY_TTL_MS) return;
    this.frames = this.frames.filter((frame) => frame.image !== normalized);
    this.frames.push({ image: normalized, capturedAtMs });
    this.frames = this.frames.slice(-MAX_PREVIOUS_SCREEN_FRAMES);
    this.scheduleExpiry();
  }

  previousFramesFor(currentImage: string): string[] {
    this.expire();
    const current = currentImage.trim();
    const newestFirst = [...this.frames]
      .filter((frame) => frame.image !== current)
      .reverse();
    const selected: string[] = [];
    let size = 0;
    for (const frame of newestFirst) {
      if (size + frame.image.length > MAX_PREVIOUS_SCREEN_FRAME_CHARS) continue;
      selected.push(frame.image);
      size += frame.image.length;
    }
    this.scheduleExpiry();
    return selected.reverse();
  }

  setPriorSolutionSummary(answer: string): void {
    this.expire();
    const summary = clipPriorSolutionSummary(answer);
    this.summary = summary || undefined;
    this.summaryUpdatedAtMs = this.summary ? this.now() : 0;
    this.scheduleExpiry();
  }

  priorSolutionSummary(): string | undefined {
    this.expire();
    this.scheduleExpiry();
    return this.summary;
  }

  /** Useful for lifecycle checks without exposing any pixel data. */
  retainedFrameCount(): number {
    return this.frames.length;
  }

  clear(): void {
    this.epoch += 1;
    this.frames = [];
    this.summary = undefined;
    this.summaryUpdatedAtMs = 0;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private expire(): void {
    const now = this.now();
    this.frames = this.frames.filter(
      (frame) => now - frame.capturedAtMs < SCREEN_FRAME_MEMORY_TTL_MS,
    );
    if (
      this.summaryUpdatedAtMs
      && now - this.summaryUpdatedAtMs >= SCREEN_FRAME_MEMORY_TTL_MS
    ) {
      this.summary = undefined;
      this.summaryUpdatedAtMs = 0;
    }
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const deadlines = [
      ...this.frames.map((frame) => frame.capturedAtMs + SCREEN_FRAME_MEMORY_TTL_MS),
      ...(this.summaryUpdatedAtMs
        ? [this.summaryUpdatedAtMs + SCREEN_FRAME_MEMORY_TTL_MS]
        : []),
    ];
    const deadline = Math.min(...deadlines);
    if (!Number.isFinite(deadline)) {
      this.expiryTimer = null;
      return;
    }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expire();
      this.scheduleExpiry();
    }, Math.max(0, deadline - this.now()));
  }
}
