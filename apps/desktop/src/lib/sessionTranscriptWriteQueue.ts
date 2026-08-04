export type SessionTranscriptWrite = () => Promise<void>;

/**
 * Serializes transcript writes per session and lets session finalization wait
 * until every accepted line has reached the backend.
 */
export class SessionTranscriptWriteQueue {
  private pending = new Map<string, Promise<void>>();

  enqueue(sessionId: string, write: SessionTranscriptWrite): Promise<void> {
    const previous = this.pending.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(write)
      .catch(() => undefined);

    this.pending.set(sessionId, current);
    void current.finally(() => {
      if (this.pending.get(sessionId) === current) this.pending.delete(sessionId);
    });
    return current;
  }

  async drain(sessionId: string): Promise<void> {
    await (this.pending.get(sessionId) ?? Promise.resolve());
  }
}
