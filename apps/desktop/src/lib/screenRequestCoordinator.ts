import type { ForcePhase } from './latestForcedAnswer';

export type ScreenRequestErrorReason =
  | 'capture_timeout'
  | 'capture_failed'
  | 'capture_empty'
  | 'stream_error'
  | 'stream_empty';

export interface ScreenRequestStreamHandlers<TMeta = unknown> {
  onChunk: (text: string) => void;
  onDone: (meta?: TMeta) => void;
  onError: (message: string, code?: string) => void;
}

export interface ScreenRequestTerminal<TMeta = unknown> {
  status: 'done' | 'error';
  answer: string;
  meta?: TMeta;
  reason?: ScreenRequestErrorReason;
  message?: string;
  errorCode?: string;
}

export interface ScreenRequestPresentation {
  text: string;
  streaming: false;
  issue?: string;
  /** Only complete answers may enter task context, frame summary or history. */
  complete: boolean;
}

/** Maps a terminal stream result to visible state without blessing partial code. */
export function presentScreenRequestTerminal<TMeta>(
  result: ScreenRequestTerminal<TMeta>,
): ScreenRequestPresentation {
  if (result.status === 'done') {
    return { text: result.answer, streaming: false, complete: true };
  }
  return {
    text: result.answer,
    streaming: false,
    issue: result.message ?? 'Ответ по экрану не завершён. Повторите запрос.',
    complete: false,
  };
}

export interface ScreenRequestOperation<TMeta = unknown> {
  capture: () => Promise<string>;
  startStream: (
    image: string,
    handlers: ScreenRequestStreamHandlers<TMeta>,
  ) => () => void;
  onCaptured?: (image: string) => void;
  onChunk?: (text: string) => void;
  onTerminal: (result: ScreenRequestTerminal<TMeta>) => void;
}

export interface ScreenRequestToken {
  generation: number;
}

interface ActiveScreenRequest<TMeta> {
  token: ScreenRequestToken;
  operation: ScreenRequestOperation<TMeta>;
  captureTimeout: ReturnType<typeof setTimeout> | null;
  cancel: (() => void) | null;
  answer: string;
}

/**
 * Owns one screen capture/stream at a time. A duplicate start is coalesced;
 * terminal callbacks only settle the request that created them.
 */
export class ScreenRequestCoordinator {
  private nextGeneration = 0;
  private active: ActiveScreenRequest<unknown> | null = null;

  constructor(private readonly options: { captureTimeoutMs: number }) {}

  isActive(): boolean {
    return this.active !== null;
  }

  start<TMeta>(operation: ScreenRequestOperation<TMeta>): ScreenRequestToken | null {
    if (this.active) return null;

    const token = { generation: ++this.nextGeneration };
    const active: ActiveScreenRequest<TMeta> = {
      token,
      operation,
      captureTimeout: null,
      cancel: null,
      answer: '',
    };
    this.active = active as ActiveScreenRequest<unknown>;
    active.captureTimeout = setTimeout(() => {
      this.settle(token, { status: 'error', answer: '', reason: 'capture_timeout' });
    }, this.options.captureTimeoutMs);

    void Promise.resolve().then(operation.capture).then(
      (image) => {
        if (!this.owns(token)) return;
        if (!image) {
          this.settle(token, { status: 'error', answer: '', reason: 'capture_empty' });
          return;
        }
        this.clearCaptureTimeout(token);
        try {
          operation.onCaptured?.(image);
        } catch (error: unknown) {
          this.settle(token, {
            status: 'error',
            answer: '',
            reason: 'capture_failed',
            message: error instanceof Error ? error.message : 'Screen capture processing failed',
          });
          return;
        }
        try {
          const cancel = operation.startStream(image, {
            onChunk: (text) => {
              if (!this.owns(token)) return;
              active.answer += text;
              operation.onChunk?.(text);
            },
            onDone: (meta) => {
              if (!active.answer.trim()) {
                this.settle(token, { status: 'error', answer: '', meta, reason: 'stream_empty' });
                return;
              }
              this.settle(token, { status: 'done', answer: active.answer, meta });
            },
            onError: (message, errorCode) => {
              this.settle(token, {
                status: 'error',
                answer: active.answer,
                reason: 'stream_error',
                message,
                ...(errorCode ? { errorCode } : {}),
              });
            },
          });
          if (this.owns(token)) active.cancel = cancel;
          else cancel();
        } catch (error: unknown) {
          this.settle(token, {
            status: 'error',
            answer: active.answer,
            reason: 'stream_error',
            message: error instanceof Error ? error.message : 'Screen stream startup failed',
          });
        }
      },
      (error: unknown) => {
        this.settle(token, {
          status: 'error',
          answer: '',
          reason: 'capture_failed',
          message: error instanceof Error ? error.message : 'Screen capture failed',
        });
      },
    );
    return token;
  }

  cancelActive(): ScreenRequestToken | null {
    const active = this.active;
    if (!active) return null;
    this.active = null;
    if (active.captureTimeout) clearTimeout(active.captureTimeout);
    active.cancel?.();
    return active.token;
  }

  private owns(token: ScreenRequestToken): boolean {
    return this.active?.token.generation === token.generation;
  }

  private clearCaptureTimeout(token: ScreenRequestToken): void {
    if (!this.owns(token) || !this.active?.captureTimeout) return;
    clearTimeout(this.active.captureTimeout);
    this.active.captureTimeout = null;
  }

  private settle<TMeta>(token: ScreenRequestToken, result: ScreenRequestTerminal<TMeta>): boolean {
    if (!this.owns(token)) return false;
    const active = this.active as ActiveScreenRequest<TMeta>;
    this.active = null;
    if (active.captureTimeout) clearTimeout(active.captureTimeout);
    active.operation.onTerminal(result);
    return true;
  }
}

export type ScreenAssistStartStatus = 'started' | 'busy';
export type ScreenFallbackLaunchStatus = ScreenAssistStartStatus | 'duplicate';

export interface ScreenFallbackRequestIdentity {
  generation: number;
  screenRevision: number;
  question: string;
}

/** A retained renderer request is launchable only while the hook still owns that force epoch. */
export function isCurrentForceScreenFallbackRequest(
  request: ScreenFallbackRequestIdentity,
  currentGeneration: number,
  phase: ForcePhase,
): boolean {
  return (
    request.generation > 0
    && request.generation === currentGeneration
    && phase === 'screen-fallback'
  );
}

/** Owns the force-screen request key and owner only after a real launch. */
export class ScreenFallbackLaunchCoordinator {
  private lastStartedKey = '';
  private owner = 0;

  launch(
    request: ScreenFallbackRequestIdentity,
    callbacks: {
      isActive: () => boolean;
      cancelActive: () => void;
      start: () => ScreenAssistStartStatus;
    },
  ): ScreenFallbackLaunchStatus {
    const requestKey = JSON.stringify(request);
    if (this.lastStartedKey === requestKey) return 'duplicate';
    if (callbacks.isActive()) {
      callbacks.cancelActive();
      this.owner = 0;
    }
    const status = callbacks.start();
    if (status !== 'started') return status;
    this.lastStartedKey = requestKey;
    this.owner = request.generation;
    return 'started';
  }

  ownerGeneration(): number {
    return this.owner;
  }

  releaseOwner(generation: number): boolean {
    if (!generation || this.owner !== generation) return false;
    this.owner = 0;
    return true;
  }

  clearRequestKey(): void {
    this.lastStartedKey = '';
  }

  reset(): void {
    this.lastStartedKey = '';
    this.owner = 0;
  }
}
