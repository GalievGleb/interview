export interface CandidateFollowUpInput {
  previousQuestion: string;
  previousAnswer: string;
  candidatePhrase: string;
}

export interface CandidateFollowUpRequest {
  prompt: string;
  displayQuestion: string;
  taskRootQuestion: string;
  taskCurrentQuestion: string;
  contextSource: CandidateTaskContextSource;
}

export interface CandidateFollowUpContext {
  previousQuestion: string;
  previousAnswer: string;
}

export interface ActiveScreenTaskContext {
  rootQuestion: string;
  currentQuestion: string;
  latestAnswer: string;
  updatedAtMs: number;
}

export type CandidateTaskContextSource = 'screen' | 'live' | 'candidate_phrase';

export interface CandidateTaskBase extends ActiveScreenTaskContext {
  source: Exclude<CandidateTaskContextSource, 'candidate_phrase'>;
}

interface CompletedLiveAnswer {
  question: string;
  spoken: string;
  ts: number;
}

const MAX_QUESTION_CHARS = 1_800;
const MAX_ANSWER_CHARS = 5_200;
const MAX_PHRASE_CHARS = 1_200;

function bounded(text: string, maxChars: number): string {
  const value = text.trim();
  if (value.length <= maxChars) return value;
  const tailSize = Math.floor(maxChars * 0.35);
  const headSize = maxChars - tailSize - 3;
  return `${value.slice(0, headSize).trimEnd()}…\n${value.slice(-tailSize).trimStart()}`;
}

function boundedHead(text: string, maxChars: number): string {
  const value = text.trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Owns the bounded non-pixel context for the current screen/candidate task. */
export class ActiveScreenTaskContextMemory {
  private current: ActiveScreenTaskContext | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  publishScreenResult(input: {
    question: string;
    answer: string;
    continuesPrevious: boolean;
  }): ActiveScreenTaskContext | null {
    const question = boundedHead(input.question, MAX_QUESTION_CHARS);
    const latestAnswer = bounded(input.answer, MAX_ANSWER_CHARS);
    if (!question || !latestAnswer) return this.snapshot();
    const rootQuestion = input.continuesPrevious && this.current?.rootQuestion
      ? this.current.rootQuestion
      : question;
    this.current = {
      rootQuestion: boundedHead(rootQuestion, MAX_QUESTION_CHARS),
      currentQuestion: question,
      latestAnswer,
      updatedAtMs: this.now(),
    };
    return this.snapshot();
  }

  publishCandidateResult(input: {
    rootQuestion: string;
    currentQuestion: string;
    answer: string;
  }): ActiveScreenTaskContext | null {
    const rootQuestion = boundedHead(input.rootQuestion, MAX_QUESTION_CHARS);
    const currentQuestion = boundedHead(input.currentQuestion, MAX_QUESTION_CHARS);
    const latestAnswer = bounded(input.answer, MAX_ANSWER_CHARS);
    if (!rootQuestion || !currentQuestion || !latestAnswer) return this.snapshot();
    this.current = {
      rootQuestion,
      currentQuestion,
      latestAnswer,
      updatedAtMs: this.now(),
    };
    return this.snapshot();
  }

  selectCandidateBase(previous?: CompletedLiveAnswer): CandidateTaskBase | null {
    const screen = this.snapshot();
    const historyIsPublishedTaskResult = Boolean(
      screen
      && previous
      && boundedHead(previous.question, MAX_QUESTION_CHARS) === screen.currentQuestion
      && bounded(previous.spoken, MAX_ANSWER_CHARS) === screen.latestAnswer,
    );
    if (screen && (!previous || screen.updatedAtMs >= previous.ts || historyIsPublishedTaskResult)) {
      return { ...screen, source: 'screen' };
    }
    if (!previous?.question.trim() || !previous.spoken.trim()) return null;
    return {
      rootQuestion: boundedHead(previous.question, MAX_QUESTION_CHARS),
      currentQuestion: boundedHead(previous.question, MAX_QUESTION_CHARS),
      latestAnswer: bounded(previous.spoken, MAX_ANSWER_CHARS),
      updatedAtMs: previous.ts,
      source: 'live',
    };
  }

  contextForInterviewQuestion(input: {
    resetPreviousTopic: boolean;
    requiresScreenContext: boolean;
  }): ActiveScreenTaskContext | null {
    if (input.resetPreviousTopic && !input.requiresScreenContext) {
      this.clear();
      return null;
    }
    return this.snapshot();
  }

  settleCandidateStream(input: {
    completed: boolean;
    rootQuestion: string;
    currentQuestion: string;
    answer: string;
  }): { persistHistory: boolean } {
    if (!input.completed) return { persistHistory: false };
    const published = this.publishCandidateResult(input);
    return { persistHistory: Boolean(published) };
  }

  snapshot(): ActiveScreenTaskContext | null {
    return this.current ? { ...this.current } : null;
  }

  clear(): void {
    this.current = null;
  }
}

/**
 * Собирает один быстрый LLM-запрос для уточнения кандидата. Предыдущая задача
 * и ответ передаются прямо в запросе: серверу не нужен второй вызов за историей.
 */
export function buildCandidateFollowUpRequest(
  input: CandidateFollowUpInput,
): CandidateFollowUpRequest {
  const previousQuestion = bounded(input.previousQuestion, MAX_QUESTION_CHARS);
  const previousAnswer = bounded(input.previousAnswer, MAX_ANSWER_CHARS);
  const candidatePhrase = bounded(input.candidatePhrase, MAX_PHRASE_CHARS);

  return {
    displayQuestion: candidatePhrase,
    taskRootQuestion: previousQuestion,
    taskCurrentQuestion: candidatePhrase,
    contextSource: 'live',
    prompt: [
      'Это уточнение кандидата к текущему решению, а не реплика интервьюера.',
      'Продолжи работу одним ответом с учётом уточнения.',
      'Если просят добавить варианты — не повторяй уже сказанное, добавь полезное продолжение.',
      'Если просят изменить код или решение — сохрани рабочие части и верни актуальный вариант целиком.',
      '',
      `Текущая задача:\n${previousQuestion}`,
      '',
      `Предыдущий ответ:\n${previousAnswer}`,
      '',
      `Уточнение кандидата:\n${candidatePhrase}`,
    ].join('\n'),
  };
}

/** Связывает поздний STT-final только с тем Ctrl+\, который его запросил. */
export class CandidateFollowUpGenerationOwner {
  private pending: (CandidateTaskBase & { generation: number }) | null | undefined;

  begin(generation: number, context: CandidateTaskBase | CandidateFollowUpContext | null): void {
    if (!context) {
      this.pending = null;
      this.pendingGeneration = generation;
      return;
    }
    const normalized: CandidateTaskBase = 'rootQuestion' in context
      ? context
      : {
          rootQuestion: context.previousQuestion,
          currentQuestion: context.previousQuestion,
          latestAnswer: context.previousAnswer,
          updatedAtMs: 0,
          source: 'live',
        };
    this.pending = { generation, ...normalized };
    this.pendingGeneration = generation;
  }

  private pendingGeneration: number | null = null;

  isOwned(generation: number): boolean {
    return this.pendingGeneration === generation;
  }

  build(generation: number, candidatePhrase: string): CandidateFollowUpRequest | null {
    if (this.pendingGeneration !== generation) return null;
    const context = this.pending;
    this.pending = null;
    this.pendingGeneration = null;
    const phrase = bounded(candidatePhrase, MAX_PHRASE_CHARS);
    if (!phrase) return null;
    if (!context) {
      return {
        prompt: phrase,
        displayQuestion: phrase,
        taskRootQuestion: phrase,
        taskCurrentQuestion: phrase,
        contextSource: 'candidate_phrase',
      };
    }
    const request = buildCandidateFollowUpRequest({
      previousQuestion: context.currentQuestion,
      previousAnswer: context.latestAnswer,
      candidatePhrase: phrase,
    });
    return {
      ...request,
      taskRootQuestion: context.rootQuestion,
      contextSource: context.source,
    };
  }

  clear(generation?: number): void {
    if (generation != null && this.pendingGeneration !== generation) return;
    this.pending = null;
    this.pendingGeneration = null;
  }
}

/**
 * Atomic boundary for an owned candidate final: stale/empty finals have no
 * side effects; a valid owned final retires screen work once and submits once.
 */
export function dispatchOwnedCandidateFollowUp(input: {
  owner: CandidateFollowUpGenerationOwner;
  generation: number;
  candidatePhrase: string;
  cancelActiveScreen: () => void;
  requestProvider: (request: CandidateFollowUpRequest) => void;
}): CandidateFollowUpRequest | null {
  const request = input.owner.build(input.generation, input.candidatePhrase);
  if (!request) return null;
  input.cancelActiveScreen();
  input.requestProvider(request);
  return request;
}
