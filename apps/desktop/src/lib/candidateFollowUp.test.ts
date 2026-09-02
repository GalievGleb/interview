import { describe, expect, it } from 'vitest';
import {
  ActiveScreenTaskContextMemory,
  buildCandidateFollowUpRequest,
  CandidateFollowUpGenerationOwner,
} from './candidateFollowUp';
import { LatestForcedAnswerCoordinator } from './latestForcedAnswer';

describe('buildCandidateFollowUpRequest', () => {
  it('turns the candidate mic phrase into a continuation of the completed task', () => {
    const request = buildCandidateFollowUpRequest({
      previousQuestion: 'Как протестировать окно?',
      previousAnswer: 'Сначала проверю открытие, закрытие и изменение размера.',
      candidatePhrase: '  Надо подумать, какие ещё варианты проверок существуют.  ',
    });

    expect(request.displayQuestion).toBe(
      'Надо подумать, какие ещё варианты проверок существуют.',
    );
    expect(request.prompt).toContain('Текущая задача:\nКак протестировать окно?');
    expect(request.prompt).toContain(
      'Предыдущий ответ:\nСначала проверю открытие, закрытие и изменение размера.',
    );
    expect(request.prompt).toContain(
      'Уточнение кандидата:\nНадо подумать, какие ещё варианты проверок существуют.',
    );
    expect(request.prompt).toContain('не реплика интервьюера');
    expect(request.prompt).toContain('одним ответом');
  });

  it('keeps the latest phrase and bounds old context so the live request stays fast', () => {
    const request = buildCandidateFollowUpRequest({
      previousQuestion: `Задача ${'Q'.repeat(5_000)}`,
      previousAnswer: `Ответ ${'A'.repeat(12_000)}`,
      candidatePhrase: 'Добавь негативные проверки.',
    });

    expect(request.prompt.length).toBeLessThan(10_000);
    expect(request.prompt).toContain('Добавь негативные проверки.');
    expect(request.displayQuestion).toBe('Добавь негативные проверки.');
  });
});

describe('CandidateFollowUpGenerationOwner', () => {
  it('wraps only the mic phrase owned by the candidate hotkey generation', () => {
    const owner = new CandidateFollowUpGenerationOwner();
    owner.begin(7, {
      previousQuestion: 'Напиши проверки для формы.',
      previousAnswer: 'Проверю обязательные поля.',
    });

    expect(owner.build(6, 'Добавь проверки границ.')).toBeNull();
    const request = owner.build(7, 'Добавь проверки границ.');
    expect(request?.displayQuestion).toBe('Добавь проверки границ.');
    expect(request?.prompt).toContain('Проверю обязательные поля.');
    expect(owner.isOwned(7)).toBe(false);
  });

  it('replacing a pending generation prevents a late final from using stale context', () => {
    const owner = new CandidateFollowUpGenerationOwner();
    owner.begin(2, { previousQuestion: 'Старая задача', previousAnswer: 'Старый ответ' });
    owner.begin(3, { previousQuestion: 'Новая задача', previousAnswer: 'Новый ответ' });

    expect(owner.build(2, 'Поздняя фраза')).toBeNull();
    expect(owner.build(3, 'Продолжи')).toMatchObject({ displayQuestion: 'Продолжи' });
  });

  it('bootstraps from the candidate phrase before any voice or screen answer exists', () => {
    const owner = new CandidateFollowUpGenerationOwner();
    owner.begin(1, null);

    expect(owner.build(1, 'Напиши функцию, которая разворачивает строку.')).toMatchObject({
      prompt: 'Напиши функцию, которая разворачивает строку.',
      displayQuestion: 'Напиши функцию, которая разворачивает строку.',
      taskRootQuestion: 'Напиши функцию, которая разворачивает строку.',
      taskCurrentQuestion: 'Напиши функцию, которая разворачивает строку.',
      contextSource: 'candidate_phrase',
    });
  });

  it('uses one active-speech press to flush and consume its owned final', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'candidate-finalize');
    const owner = new CandidateFollowUpGenerationOwner();
    const pressed = coordinator.press([], 'mic', true);
    expect(pressed).toMatchObject({
      action: 'flush',
      generation: 1,
      requestId: 'candidate-finalize',
    });
    owner.begin(1, null);

    const decision = coordinator.acceptFinal({
      sequence: 8,
      text: 'Напиши функцию, которая разворачивает строку.',
      source: 'mic',
    }, 'candidate-finalize');
    expect(decision).toMatchObject({ action: 'submit', generation: 1, sequence: 8 });
    if (decision.action !== 'submit') throw new Error('Expected owned candidate final');
    expect(owner.build(decision.generation, decision.question)).toMatchObject({
      prompt: 'Напиши функцию, которая разворачивает строку.',
      contextSource: 'candidate_phrase',
    });
  });

  it('selects a newer screen task over an older completed live answer', () => {
    const memory = new ActiveScreenTaskContextMemory(() => 5_000);
    memory.publishScreenResult({
      question: 'Реализуй LRU cache.',
      answer: 'class LruCache: ...',
      continuesPrevious: false,
    });

    expect(memory.selectCandidateBase({
      question: 'Что такое REST?',
      spoken: 'REST — архитектурный стиль.',
      ts: 1_000,
    })).toMatchObject({
      source: 'screen',
      rootQuestion: 'Реализуй LRU cache.',
      currentQuestion: 'Реализуй LRU cache.',
      latestAnswer: 'class LruCache: ...',
    });
  });

  it('preserves the original root through repeated candidate refinements', () => {
    const memory = new ActiveScreenTaskContextMemory(() => 9_000);
    memory.publishScreenResult({
      question: 'Реализуй LRU cache.',
      answer: 'Первая реализация.',
      continuesPrevious: false,
    });
    memory.publishCandidateResult({
      rootQuestion: memory.snapshot()!.rootQuestion,
      currentQuestion: 'Добавь TTL.',
      answer: 'Реализация с TTL.',
    });
    memory.publishCandidateResult({
      rootQuestion: memory.snapshot()!.rootQuestion,
      currentQuestion: 'Сделай потокобезопасным.',
      answer: 'Потокобезопасная реализация с TTL.',
    });

    expect(memory.snapshot()).toEqual({
      rootQuestion: 'Реализуй LRU cache.',
      currentQuestion: 'Сделай потокобезопасным.',
      latestAnswer: 'Потокобезопасная реализация с TTL.',
      updatedAtMs: 9_000,
    });
  });

  it('keeps the task root when the matching history entry is saved a millisecond later', () => {
    let now = 9_000;
    const memory = new ActiveScreenTaskContextMemory(() => now);
    memory.publishScreenResult({
      question: 'Реализуй LRU cache.',
      answer: 'Первая реализация.',
      continuesPrevious: false,
    });
    memory.publishCandidateResult({
      rootQuestion: 'Реализуй LRU cache.',
      currentQuestion: 'Добавь TTL.',
      answer: 'Реализация с TTL.',
    });
    now += 1;

    expect(memory.selectCandidateBase({
      question: 'Добавь TTL.',
      spoken: 'Реализация с TTL.',
      ts: now,
    })).toMatchObject({
      source: 'screen',
      rootQuestion: 'Реализуй LRU cache.',
      currentQuestion: 'Добавь TTL.',
    });
  });

  it('bounds the active context while retaining the root start and latest answer tail', () => {
    const memory = new ActiveScreenTaskContextMemory(() => 12_000);
    memory.publishScreenResult({
      question: `ROOT_START ${'q'.repeat(5_000)}`,
      answer: `${'a'.repeat(12_000)} LATEST_ANSWER_TAIL`,
      continuesPrevious: false,
    });

    const context = memory.snapshot()!;
    expect(context.rootQuestion).toContain('ROOT_START');
    expect(context.currentQuestion.length).toBeLessThanOrEqual(1_800);
    expect(context.latestAnswer.length).toBeLessThanOrEqual(5_200);
    expect(context.latestAnswer).toContain('LATEST_ANSWER_TAIL');
  });

  it('retires an unrelated screen task before the new topic and its elliptical follow-up', () => {
    const memory = new ActiveScreenTaskContextMemory(() => 12_000);
    memory.publishScreenResult({
      question: 'Реализуй LRU cache.',
      answer: 'class LruCache: ...',
      continuesPrevious: false,
    });

    const dnsRequestContext = memory.contextForInterviewQuestion({
      resetPreviousTopic: true,
      requiresScreenContext: false,
    });
    const dnsDisadvantagesFollowUpContext = memory.contextForInterviewQuestion({
      resetPreviousTopic: false,
      requiresScreenContext: false,
    });

    expect(JSON.stringify({
      question: 'Что такое DNS?',
      activeScreenTask: dnsRequestContext,
    })).not.toContain('Реализуй LRU cache.');
    expect(JSON.stringify({
      question: 'Его недостатки?',
      activeScreenTask: dnsDisadvantagesFollowUpContext,
    })).not.toContain('Реализуй LRU cache.');
    expect(dnsRequestContext).toBeNull();
    expect(dnsDisadvantagesFollowUpContext).toBeNull();
    expect(memory.snapshot()).toBeNull();
  });

  it('keeps the last complete task when a candidate refinement stream fails', () => {
    const memory = new ActiveScreenTaskContextMemory(() => 12_000);
    memory.publishScreenResult({
      question: 'Реализуй LRU cache.',
      answer: 'Полная реализация LRU.',
      continuesPrevious: false,
    });

    const settlement = memory.settleCandidateStream({
      completed: false,
      rootQuestion: 'Реализуй LRU cache.',
      currentQuestion: 'Добавь TTL.',
      answer: 'class LruCache { /* обрезано',
    });

    expect(settlement.persistHistory).toBe(false);
    expect(memory.snapshot()).toMatchObject({
      currentQuestion: 'Реализуй LRU cache.',
      latestAnswer: 'Полная реализация LRU.',
    });
  });
});
