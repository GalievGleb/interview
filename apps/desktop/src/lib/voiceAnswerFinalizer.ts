export interface FinalizableVoiceSession {
  stopCapture(): void;
  flush(requestId: string): boolean;
  stop(): void;
}

interface VoiceAnswerFinalizerOptions {
  createRequestId?: () => string;
  timeoutMs?: number;
}

export interface VoiceAnswerFinalizationResult {
  status: 'completed' | 'cancelled';
  text: string;
}

interface PendingFinalization {
  requestId: string;
  session: FinalizableVoiceSession;
  readTranscript: () => string;
  promise: Promise<VoiceAnswerFinalizationResult>;
  resolve: (result: VoiceAnswerFinalizationResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createVoiceAnswerFinalizer(options: VoiceAnswerFinalizerOptions = {}) {
  const createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  const timeoutMs = options.timeoutMs ?? 10_000;
  let pending: PendingFinalization | null = null;

  const complete = (status: VoiceAnswerFinalizationResult['status']): boolean => {
    const current = pending;
    if (!current) return false;

    pending = null;
    if (current.timer) clearTimeout(current.timer);

    let transcript: string;
    try {
      transcript = current.readTranscript();
    } finally {
      current.session.stop();
    }
    current.resolve({ status, text: transcript });
    return true;
  };

  const settle = (requestId: string | undefined): boolean => {
    if (!pending || !requestId || requestId !== pending.requestId) return false;
    return complete('completed');
  };

  return {
    finish(
      session: FinalizableVoiceSession,
      readTranscript: () => string,
    ): Promise<VoiceAnswerFinalizationResult> {
      if (pending) return pending.promise;

      session.stopCapture();
      const requestId = createRequestId();
      let resolvePromise!: (result: VoiceAnswerFinalizationResult) => void;
      const promise = new Promise<VoiceAnswerFinalizationResult>((resolve) => {
        resolvePromise = resolve;
      });
      pending = {
        requestId,
        session,
        readTranscript,
        promise,
        resolve: resolvePromise,
        timer: null,
      };
      pending.timer = setTimeout(() => complete('completed'), timeoutMs);

      if (!session.flush(requestId)) complete('completed');
      return promise;
    },
    settle,
    cancel(): boolean {
      return complete('cancelled');
    },
    isPending(): boolean {
      return pending !== null;
    },
  };
}
