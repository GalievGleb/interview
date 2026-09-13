export interface RecentLiveTurn { question: string; answer: string }
export const CANDIDATE_SOURCES_EPOCH_KEY = 'skillcue.candidate-sources-epoch';

/** Only an invalidation nonce crosses windows; candidate text/history never enters storage. */
export function notifyCandidateSourcesChanged<T>(result: T): T {
  try { localStorage.setItem(CANDIDATE_SOURCES_EPOCH_KEY, `${Date.now()}:${Math.random()}`); } catch { /* unavailable */ }
  window.dispatchEvent(new Event('skillcue:candidate-sources-updated'));
  return result;
}

export class LiveAnswerMemory {
  epoch = 0;
  private turns: RecentLiveTurn[] = [];
  reset(): number { this.turns = []; return ++this.epoch; }
  complete(epoch: number, question: string, answer: string, completed: boolean): void {
    if (epoch !== this.epoch || !completed || !question.trim() || !answer.trim()) return;
    this.turns = [...this.turns.slice(-1), {
      question: question.trim().slice(0, 800), answer: answer.trim().slice(0, 1800),
    }];
  }
  snapshot(): RecentLiveTurn[] { return this.turns.map((turn) => ({ ...turn })); }
}
