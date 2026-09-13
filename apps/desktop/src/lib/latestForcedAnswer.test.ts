import { afterEach, describe, expect, it, vi } from 'vitest';
import * as forcedAnswerModule from './latestForcedAnswer';
import {
  expireDelayedForcedTranscript,
  LatestForcedAnswerCoordinator,
  notifyDelayedForcedTranscript,
} from './latestForcedAnswer';

afterEach(() => {
  vi.useRealTimers();
});

describe('LatestForcedAnswerCoordinator', () => {
  it('expires only the still-owned delayed transcript request', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-2');
    coordinator.press([{ sequence: 1, text: 'First question', source: 'system' }], 'system');
    coordinator.setPhase(1, 'done');
    const force = coordinator.press([], 'system', true);
    if (force.action !== 'flush') throw new Error(`Expected flush, got ${force.action}`);
    const expired = vi.fn();

    expect(notifyDelayedForcedTranscript(coordinator, 2, () => {})).toBe(true);
    expect(expireDelayedForcedTranscript(coordinator, 2, expired)).toBe(true);
    expect(expired).toHaveBeenCalledWith(2);
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'error',
      requestId: null,
      pendingRequestCount: 0,
    });
    expect(
      coordinator.acceptFinal(
        { sequence: 2, text: 'Late second question', source: 'system' },
        force.requestId,
      ),
    ).toEqual({ action: 'store-only' });
  });

  it('cannot expire a newer transcript generation with an older deadline', () => {
    const ids = ['force-1', 'force-2'];
    const coordinator = new LatestForcedAnswerCoordinator(() => ids.shift()!);
    coordinator.press([], 'system', true);
    coordinator.press([], 'system', true);

    expect(expireDelayedForcedTranscript(coordinator, 1, () => {})).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({
      generation: 2,
      phase: 'finalizing-transcript',
      requestId: 'force-2',
      pendingRequestCount: 1,
    });
  });

  it('does not expire a successful answer that completed before the deadline', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    const force = coordinator.press([], 'system', true);
    if (force.action !== 'flush') throw new Error(`Expected flush, got ${force.action}`);
    expect(
      coordinator.acceptFinal(
        { sequence: 1, text: 'Completed question', source: 'system' },
        force.requestId,
      ),
    ).toMatchObject({ action: 'submit', generation: 1 });
    coordinator.setPhase(1, 'streaming');
    coordinator.setPhase(1, 'done');

    expect(expireDelayedForcedTranscript(coordinator, 1, () => {})).toBe(false);
    expect(coordinator.snapshot()).toMatchObject({ phase: 'done', pendingRequestCount: 0 });
  });

  it('keeps a forced conversation request pending when the STT final is delayed', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-test-design');
    const waiting = vi.fn();

    expect(coordinator.press([], 'system', true)).toMatchObject({
      action: 'flush',
      generation: 1,
      requestId: 'force-test-design',
    });

    expect(notifyDelayedForcedTranscript(coordinator, 1, waiting)).toBe(true);
    expect(waiting).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({
      generation: 1,
      phase: 'finalizing-transcript',
      pendingRequestCount: 1,
    });
    expect(
      coordinator.acceptFinal(
        {
          sequence: 1,
          text: 'Какие техники тест-дизайна ты применяешь?',
          source: 'system',
        },
        'force-test-design',
      ),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      question: 'Какие техники тест-дизайна ты применяешь?',
    });
  });

  it('lets the newest Ctrl+Enter supersede an older finalization', () => {
    const ids = ['force-1', 'force-2'];
    const coordinator = new LatestForcedAnswerCoordinator(() => ids.shift()!);

    expect(coordinator.press([], 'system')).toMatchObject({
      action: 'flush',
      generation: 1,
      requestId: 'force-1',
      source: 'system',
    });
    expect(coordinator.press([], 'system')).toMatchObject({
      action: 'flush',
      generation: 2,
      requestId: 'force-2',
      source: 'system',
    });

    expect(coordinator.acceptFinal({ sequence: 1, text: 'Old question' }, 'force-1')).toEqual({
      action: 'store-only',
    });
    expect(
      coordinator.acceptFinal({ sequence: 2, text: 'Which test-design techniques?' }, 'force-2'),
    ).toMatchObject({
      action: 'submit',
      generation: 2,
      question: 'Which test-design techniques?',
    });
  });

  it('waits for the request-tagged latest final instead of answering an earlier id-less final', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'system');

    expect(
      coordinator.acceptFinal({
        sequence: 7,
        text: 'Какие бывают техники тестирования?',
        source: 'system',
      }),
    ).toEqual({ action: 'wait', generation: 1 });
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'finalizing-transcript',
      consumedSequence: 0,
      generation: 1,
    });
    expect(
      coordinator.acceptFinal(
        {
          sequence: 8,
          text: 'Что ты знаешь про принципы REST API?',
          source: 'system',
        },
        'force-1',
      ),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      sequence: 8,
      question: 'Что ты знаешь про принципы REST API?',
    });
  });

  it('ignores a late empty result after the tagged final consumed the request', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'system');
    coordinator.acceptFinal({ sequence: 7, text: 'Use this final' }, 'force-1');

    expect(coordinator.acceptEmpty('force-1')).toEqual({ action: 'store-only' });
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'waiting-first-token',
      consumedSequence: 7,
    });
  });

  it('keeps the current generation pending when an empty result races a late final', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'mic');

    expect(coordinator.acceptEmpty('force-1')).toEqual({ action: 'wait', generation: 1 });
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'finalizing-transcript',
      requestId: 'force-1',
      generation: 1,
    });
    expect(
      coordinator.acceptFinal(
        {
          sequence: 1,
          text: 'Что такое тестирование?',
          source: 'mic',
        },
        'force-1',
      ),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      question: 'Что такое тестирование?',
    });
  });

  it('submits the current id-less final after force-empty reports an already active STT job', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-wav', () => 100_000);
    coordinator.press([], 'mic', true);

    expect(coordinator.acceptEmpty('force-wav')).toEqual({ action: 'wait', generation: 1 });
    expect(
      coordinator.acceptFinal({
        sequence: 1,
        text: 'Расскажи, пожалуйста, про техники тест-дизайна, какие ты знаешь.',
        source: 'mic',
        utteranceId: 'wav-2026-08-25-11-11-24',
        capturedAtMs: 99_800,
      }),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      sequence: 1,
      question: 'Расскажи, пожалуйста, про техники тест-дизайна, какие ты знаешь.',
    });
  });

  it('submits an id-less final that wins the race just before force-empty', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-race', () => 100_000);
    coordinator.press([], 'mic', true);

    expect(
      coordinator.acceptFinal({
        sequence: 1,
        text: 'Привет! Расскажи, пожалуйста, про виды тестирования, которые ты знаешь.',
        source: 'mic',
        utteranceId: 'user-wav-final-before-empty',
        capturedAtMs: 99_800,
      }),
    ).toEqual({ action: 'wait', generation: 1 });

    expect(coordinator.acceptEmpty('force-race')).toMatchObject({
      action: 'submit',
      generation: 1,
      sequence: 1,
      question: 'Привет! Расскажи, пожалуйста, про виды тестирования, которые ты знаешь.',
    });
    expect(coordinator.snapshot()).toMatchObject({
      phase: 'waiting-first-token',
      requestId: null,
      consumedSequence: 1,
    });
  });

  it('routes a finalized visual-reference question to screen without starting text LLM', () => {
    const coordinator = new LatestForcedAnswerCoordinator();
    const decision = coordinator.press(
      [{ sequence: 1, text: 'Что выведет этот код?', source: 'system' }],
      'system',
    );
    expect(decision).toMatchObject({ action: 'submit', generation: 1 });
    expect(coordinator.routeQuestionToScreen(1)).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      generation: 1,
      phase: 'screen-fallback',
      requestId: null,
    });
    expect(coordinator.routeQuestionToScreen(0)).toBe(false);
  });

  it('keeps interviewer finals that arrive after an explicit screen answer for the next Ctrl+Enter', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');
    const first = {
      sequence: 1,
      text: 'Что выведет этот код?',
      source: 'system' as const,
    };
    const second = {
      sequence: 2,
      text: 'Теперь составь тест-план для этого POST endpoint.',
      source: 'system' as const,
    };

    expect(coordinator.press([first], 'system')).toMatchObject({
      action: 'submit',
      generation: 1,
      sequence: 1,
    });
    expect(coordinator.routeQuestionToScreen(1)).toBe(true);

    // The screen request has no pending STT request owner. A later id-less
    // interviewer final belongs to the next question and must stay unconsumed.
    expect(coordinator.acceptFinal(second)).toEqual({ action: 'store-only' });
    expect(coordinator.snapshot().consumedSequence).toBe(1);
    expect(coordinator.press([first, second], 'system')).toMatchObject({
      action: 'submit',
      generation: 2,
      sequence: 2,
      question: second.text,
    });
  });

  it('keeps accepting the real transcript after screen fallback has started', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1', () => 10_000);
    coordinator.press([], 'system');

    expect(coordinator.beginScreenFallback(1)).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      generation: 1,
      phase: 'screen-fallback',
      requestId: 'force-1',
      pendingRequestCount: 1,
    });
    expect(
      coordinator.acceptFinal(
        {
          sequence: 1,
          text: 'Какие бывают техники тест-дизайна?',
          source: 'system',
          capturedAtMs: 9_000,
        },
        'force-1',
      ),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      question: 'Какие бывают техники тест-дизайна?',
    });
  });

  it('does not consume a final from the wrong source while finalizing', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1');
    coordinator.press([], 'system');

    expect(
      coordinator.acceptFinal({
        sequence: 1,
        text: 'My microphone answer',
        source: 'mic',
      }),
    ).toEqual({ action: 'store-only' });
    expect(
      coordinator.acceptFinal(
        {
          sequence: 2,
          text: 'The interviewer question',
          source: 'system',
        },
        'force-1',
      ),
    ).toMatchObject({
      action: 'submit',
      question: 'The interviewer question',
    });
  });

  it('submits an already finalized unconsumed question without STT flush', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');

    expect(coordinator.press([{ sequence: 3, text: 'How do you handle flaky tests?' }], 'system'))
      .toMatchObject({
        action: 'submit',
        generation: 1,
        sequence: 3,
        question: 'How do you handle flaky tests?',
      });
  });

  it('submits every final fragment of the current question on one Ctrl+Enter press', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');

    expect(
      coordinator.press(
        [
          {
            sequence: 3,
            text: 'Можешь написать list comprehension, который считает от 1 до 10?',
            source: 'system',
          },
          {
            sequence: 4,
            text: 'И выводит также значение квадрата.',
            source: 'system',
          },
        ],
        'system',
      ),
    ).toMatchObject({
      action: 'submit',
      generation: 1,
      sequence: 4,
      question:
        'Можешь написать list comprehension, который считает от 1 до 10? И выводит также значение квадрата.',
    });
  });

  it('keeps multiple complete subquestions spoken before one Ctrl+Enter press', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');

    expect(
      coordinator.press(
        [
          {
            sequence: 1,
            text: 'Расскажите о последнем проекте?',
            source: 'system',
            receivedAt: 1_000,
          },
          {
            sequence: 2,
            text: 'Какие задачи вы выполняли?',
            source: 'system',
            receivedAt: 2_000,
          },
        ],
        'system',
      ),
    ).toMatchObject({
      action: 'submit',
      sequence: 2,
      question: 'Расскажите о последнем проекте? Какие задачи вы выполняли?',
    });
  });

  it('does not repeat fragments consumed by the previous Ctrl+Enter press', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');
    const first = { sequence: 1, text: 'Что такое API?', source: 'system' as const };

    expect(coordinator.press([first], 'system')).toMatchObject({
      action: 'submit',
      sequence: 1,
      question: 'Что такое API?',
    });
    expect(
      coordinator.press(
        [
          first,
          { sequence: 2, text: 'Напиши функцию от 1 до 10.', source: 'system' },
          { sequence: 3, text: 'И выведи квадрат каждого числа.', source: 'system' },
        ],
        'system',
      ),
    ).toMatchObject({
      action: 'submit',
      sequence: 3,
      question: 'Напиши функцию от 1 до 10. И выведи квадрат каждого числа.',
    });
  });

  it('does not mix microphone finals into a system-audio question', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');

    expect(
      coordinator.press(
        [
          { sequence: 1, text: 'Расскажите про REST API.', source: 'system' },
          { sequence: 2, text: 'Да, сейчас отвечу.', source: 'mic' },
          { sequence: 3, text: 'И приведите пример идемпотентности.', source: 'system' },
        ],
        'system',
      ),
    ).toMatchObject({
      action: 'submit',
      sequence: 3,
      question: 'Расскажите про REST API. И приведите пример идемпотентности.',
    });
  });

  it('combines an already finalized prefix with the forced final of current speech', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-current');

    expect(
      coordinator.press(
        [{ sequence: 1, text: 'Можешь написать функцию от 1 до 10?', source: 'mic' }],
        'mic',
        true,
      ),
    ).toMatchObject({
      action: 'flush',
      requestId: 'force-current',
      source: 'mic',
    });
    expect(
      coordinator.acceptFinal(
        { sequence: 2, text: 'И вывести квадрат каждого числа.', source: 'mic' },
        'force-current',
      ),
    ).toMatchObject({
      action: 'submit',
      sequence: 2,
      question: 'Можешь написать функцию от 1 до 10? И вывести квадрат каждого числа.',
    });
  });

  it('submits a stabilized finalized prefix when forced flush finds no continuation', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-prefix');
    const force = coordinator.press(
      [
        {
          sequence: 1,
          text: 'Какие техники тест-дизайна ты знаешь?',
          source: 'mic',
        },
      ],
      'mic',
      true,
    );
    if (force.action !== 'flush') throw new Error(`Expected flush, got ${force.action}`);

    expect(coordinator.acceptEmpty(force.requestId)).toEqual({
      action: 'wait',
      generation: 1,
    });
    expect(coordinator.commitFinalizedPrefix(force.requestId)).toMatchObject({
      action: 'submit',
      generation: 1,
      sequence: 1,
      question: 'Какие техники тест-дизайна ты знаешь?',
    });
  });

  it('does not prepend a stale final separated from current speech by a long gap', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-current');
    coordinator.press(
      [
        {
          sequence: 1,
          text: 'Что такое REST API?',
          source: 'system',
          receivedAt: 1_000,
        },
      ],
      'system',
      true,
    );

    expect(
      coordinator.acceptFinal(
        {
          sequence: 2,
          text: 'Напиши функцию для проверки статуса ответа.',
          source: 'system',
          receivedAt: 22_000,
        },
        'force-current',
      ),
    ).toMatchObject({
      action: 'submit',
      sequence: 2,
      question: 'Напиши функцию для проверки статуса ответа.',
    });
  });

  it('keeps capitalized middle fragments from the current forced question', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-current');
    coordinator.press(
      [
        {
          sequence: 1,
          text: 'Напиши функцию для списка чисел.',
          source: 'system',
          receivedAt: 1_000,
        },
        {
          sequence: 2,
          text: 'Она должна пройти от 1 до 10.',
          source: 'system',
          receivedAt: 2_000,
        },
      ],
      'system',
      true,
    );

    expect(
      coordinator.acceptFinal(
        {
          sequence: 3,
          text: 'Вернуть квадрат каждого значения.',
          source: 'system',
          receivedAt: 3_000,
        },
        'force-current',
      ),
    ).toMatchObject({
      action: 'submit',
      sequence: 3,
      question:
        'Напиши функцию для списка чисел. Она должна пройти от 1 до 10. Вернуть квадрат каждого значения.',
    });
  });

  it('does not merge finals separated by a long pause', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused');

    expect(
      coordinator.press(
        [
          {
            sequence: 1,
            text: 'Расскажи про прошлый проект.',
            source: 'system',
            receivedAt: 1_000,
          },
          {
            sequence: 2,
            text: 'И назови техники тест-дизайна.',
            source: 'system',
            receivedAt: 22_000,
          },
        ],
        'system',
      ),
    ).toMatchObject({
      action: 'submit',
      sequence: 2,
      question: 'И назови техники тест-дизайна.',
    });
  });

  it('reports empty audio only for the current request', () => {
    const ids = ['old', 'current'];
    const coordinator = new LatestForcedAnswerCoordinator(() => ids.shift()!);
    coordinator.press([], 'mic');
    coordinator.press([], 'mic');

    expect(coordinator.acceptEmpty('old')).toEqual({ action: 'store-only' });
    expect(coordinator.acceptEmpty('current')).toMatchObject({
      action: 'wait',
      generation: 2,
    });
  });

  it('never reuses a final that the normal answer flow already handled', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'next-flush');
    coordinator.markHandled(4);

    expect(
      coordinator.press([{ sequence: 4, text: 'Already answered question' }], 'system'),
    ).toMatchObject({
      action: 'flush',
      requestId: 'next-flush',
    });
  });

  it('stores a superseded final without consuming it for a later press', () => {
    const ids = ['old', 'current', 'next'];
    const coordinator = new LatestForcedAnswerCoordinator(() => ids.shift()!);
    coordinator.press([], 'system');
    coordinator.press([], 'system');

    expect(coordinator.acceptFinal({ sequence: 8, text: 'Stale question' }, 'old')).toEqual({
      action: 'store-only',
    });
    expect(coordinator.snapshot().consumedSequence).toBe(8);
    expect(coordinator.acceptEmpty('current')).toMatchObject({ action: 'wait' });
    expect(coordinator.press([{ sequence: 8, text: 'Stale question' }], 'system')).toMatchObject({
      action: 'flush',
      generation: 3,
      requestId: 'next',
    });
  });

  it('keeps a contiguous system-audio question for up to two minutes', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused', () => 200_000);

    expect(
      coordinator.press(
        [
          {
            sequence: 1,
            text: 'У нас есть POST endpoint, который оформляет заказ.',
            source: 'system',
            capturedAtMs: 110_000,
          },
          {
            sequence: 2,
            text: 'В теле есть отправления, адрес и способ оплаты.',
            source: 'system',
            capturedAtMs: 128_000,
          },
          {
            sequence: 3,
            text: 'Способ оплаты — банковская карта или бонусы.',
            source: 'system',
            capturedAtMs: 146_000,
          },
          {
            sequence: 4,
            text: 'Составь чек-лист проверок для этого метода.',
            source: 'system',
            capturedAtMs: 164_000,
          },
        ],
        'system',
      ),
    ).toMatchObject({
      action: 'submit',
      question:
        'У нас есть POST endpoint, который оформляет заказ. В теле есть отправления, адрес и способ оплаты. Способ оплаты — банковская карта или бонусы. Составь чек-лист проверок для этого метода.',
    });
  });

  it('does not lose the next question after a prompt-echo gap and a repeated Ctrl+Enter', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused', () => 200_000);
    const oldFiller = [
      {
        sequence: 1,
        text: 'Да, мы сейчас...',
        source: 'system' as const,
        capturedAtMs: 114_104,
      },
      {
        sequence: 2,
        text: 'То есть мы работаем немножко.',
        source: 'system' as const,
        capturedAtMs: 130_900,
      },
    ];
    const firstQuestion = {
      sequence: 3,
      text: 'Чем отличаются list, tuple, set и dict?',
      source: 'system' as const,
      capturedAtMs: 164_664,
    };

    expect(coordinator.press([...oldFiller, firstQuestion], 'system')).toMatchObject({
      action: 'submit',
      sequence: 3,
      question: firstQuestion.text,
    });

    const secondQuestion = {
      sequence: 4,
      text: 'Почему set обычно быстрее списка при проверке x in collection?',
      source: 'system' as const,
      capturedAtMs: 190_754,
    };
    expect(
      coordinator.press([...oldFiller, firstQuestion, secondQuestion], 'system'),
    ).toMatchObject({
      action: 'submit',
      sequence: 4,
      question: secondQuestion.text,
    });
  });

  it('keeps the mic freshness boundary at 20,000 ms', () => {
    const fresh = new LatestForcedAnswerCoordinator(() => 'unused', () => 100_000);
    expect(
      fresh.press(
        [{ sequence: 1, text: 'Boundary question', source: 'mic', capturedAtMs: 80_000 }],
        'mic',
      ),
    ).toMatchObject({ action: 'submit', question: 'Boundary question' });

    const stale = new LatestForcedAnswerCoordinator(() => 'next-force', () => 100_000);
    expect(
      stale.press(
        [{ sequence: 1, text: 'Stale question', source: 'mic', capturedAtMs: 79_999 }],
        'mic',
      ),
    ).toMatchObject({ action: 'flush', requestId: 'next-force' });
    expect(stale.snapshot().consumedSequence).toBe(1);
  });

  it('allows screen replacement at +1,500 ms but not +1,501 ms', () => {
    let now = 100_000;
    const eligible = new LatestForcedAnswerCoordinator(() => 'force-ok', () => now);
    eligible.press([], 'system');
    eligible.beginScreenFallback(1);
    now += 1_500;
    expect(
      eligible.acceptFinal(
        { sequence: 1, text: 'Fresh boundary', source: 'system', capturedAtMs: 99_000 },
        'force-ok',
      ),
    ).toMatchObject({ action: 'submit', question: 'Fresh boundary' });

    now = 200_000;
    const late = new LatestForcedAnswerCoordinator(() => 'force-late', () => now);
    late.press([], 'system');
    late.beginScreenFallback(1);
    now += 1_501;
    expect(
      late.acceptFinal(
        { sequence: 1, text: 'Too late', source: 'system', capturedAtMs: 200_000 },
        'force-late',
      ),
    ).toEqual({ action: 'store-only' });
  });

  it('accepts missing capture metadata before fallback but rejects it after fallback', () => {
    const before = new LatestForcedAnswerCoordinator(() => 'force-before', () => 10_000);
    before.press([], 'system');
    expect(
      before.acceptFinal({ sequence: 1, text: 'Legacy final', source: 'system' }, 'force-before'),
    ).toMatchObject({ action: 'submit', question: 'Legacy final' });

    const after = new LatestForcedAnswerCoordinator(() => 'force-after', () => 10_000);
    after.press([], 'system');
    after.beginScreenFallback(1);
    expect(
      after.acceptFinal({ sequence: 1, text: 'Legacy final', source: 'system' }, 'force-after'),
    ).toEqual({ action: 'store-only' });
  });

  it('first committed screen output permanently closes text replacement', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1', () => 10_000);
    coordinator.press([], 'system');
    coordinator.beginScreenFallback(1);
    const { screenRevision } = coordinator.snapshot();

    expect(coordinator.commitScreenFirstOutput(1, screenRevision)).toBe(true);
    expect(
      coordinator.acceptFinal(
        { sequence: 1, text: 'Fresh but too late', source: 'system', capturedAtMs: 9_000 },
        'force-1',
      ),
    ).toEqual({ action: 'store-only' });
  });

  it('revalidates every committed screen chunk and rejects the old owner in a new generation', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1', () => 10_000);
    coordinator.press([], 'system');
    coordinator.beginScreenFallback(1);
    const { screenRevision } = coordinator.snapshot();

    expect(coordinator.commitScreenFirstOutput(1, screenRevision)).toBe(true);
    expect(coordinator.commitScreenFirstOutput(1, screenRevision)).toBe(true);

    expect(coordinator.press([], 'system')).toMatchObject({
      action: 'flush',
      generation: 2,
    });
    expect(coordinator.snapshot().phase).toBe('finalizing-transcript');
    expect(coordinator.commitScreenFirstOutput(1, screenRevision)).toBe(false);
  });

  it('cancels a committed screen owner as soon as a newer generation is finalizing', () => {
    type CancelCheck = (
      ownedGeneration: number,
      currentGeneration: number,
      phase: string,
    ) => boolean;
    const check = (
      forcedAnswerModule as unknown as { shouldCancelScreenFallbackOwner?: CancelCheck }
    ).shouldCancelScreenFallbackOwner;

    expect(check).toBeTypeOf('function');
    if (!check) return;
    expect(check(1, 2, 'finalizing-transcript')).toBe(true);
    expect(check(1, 1, 'screen-fallback')).toBe(false);
  });

  it('fresh tagged final just before first screen chunk invalidates that screen revision', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1', () => 10_000);
    coordinator.press([], 'system');
    coordinator.beginScreenFallback(1);
    const { screenRevision } = coordinator.snapshot();

    expect(
      coordinator.acceptFinal(
        { sequence: 1, text: 'Winning text', source: 'system', capturedAtMs: 9_000 },
        'force-1',
      ),
    ).toMatchObject({ action: 'submit', question: 'Winning text' });
    expect(coordinator.commitScreenFirstOutput(1, screenRevision)).toBe(false);
  });

  it('repeated fallback events do not extend the original replacement deadline', () => {
    let now = 5_000;
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1', () => now);
    coordinator.press([], 'system');
    coordinator.beginScreenFallback(1);
    const first = coordinator.snapshot();
    now += 1_000;
    coordinator.beginScreenFallback(1);
    expect(coordinator.snapshot()).toMatchObject({
      fallbackStartedAtMs: first.fallbackStartedAtMs,
      fallbackDeadlineMs: first.fallbackDeadlineMs,
      screenRevision: first.screenRevision,
    });
    now = 6_501;
    expect(
      coordinator.acceptFinal(
        { sequence: 1, text: 'After original deadline', source: 'system', capturedAtMs: 5_000 },
        'force-1',
      ),
    ).toEqual({ action: 'store-only' });
  });

  it('does not restart the same-generation fallback timer after another empty result', () => {
    type Scheduler = {
      schedule: (generation: number, delayMs: number) => boolean;
      cancel: (generation?: number) => boolean;
      snapshot: () => { generation: number; deadlineMs: number } | null;
    };
    type SchedulerConstructor = new (onElapsed: (generation: number) => void) => Scheduler;
    const Scheduler = (
      forcedAnswerModule as unknown as { ForceFallbackScheduler?: SchedulerConstructor }
    ).ForceFallbackScheduler;

    expect(Scheduler).toBeTypeOf('function');
    if (!Scheduler) return;

    vi.useFakeTimers();
    vi.setSystemTime(0);
    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-1', () => Date.now());
    coordinator.press([], 'system');
    const scheduler = new Scheduler((generation) => coordinator.beginScreenFallback(generation));

    expect(scheduler.schedule(1, 1_400)).toBe(true);
    expect(scheduler.snapshot()).toEqual({ generation: 1, deadlineMs: 1_400 });
    vi.advanceTimersByTime(700);
    expect(scheduler.schedule(1, 1_400)).toBe(false);
    expect(scheduler.snapshot()).toEqual({ generation: 1, deadlineMs: 1_400 });
    vi.advanceTimersByTime(700);

    expect(coordinator.snapshot()).toMatchObject({
      phase: 'screen-fallback',
      fallbackStartedAtMs: 1_400,
      fallbackDeadlineMs: 2_900,
    });
    expect(scheduler.snapshot()).toBeNull();
  });

  it('tightens the same-generation fallback to an earlier absolute deadline', () => {
    type Scheduler = {
      schedule: (generation: number, delayMs: number) => boolean;
      snapshot: () => { generation: number; deadlineMs: number } | null;
    };
    type SchedulerConstructor = new (onElapsed: (generation: number) => void) => Scheduler;
    const Scheduler = (
      forcedAnswerModule as unknown as { ForceFallbackScheduler?: SchedulerConstructor }
    ).ForceFallbackScheduler;
    expect(Scheduler).toBeTypeOf('function');
    if (!Scheduler) return;

    vi.useFakeTimers();
    vi.setSystemTime(0);
    const elapsed: number[] = [];
    const scheduler = new Scheduler((generation) => elapsed.push(generation));

    expect(scheduler.schedule(1, 3_500)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(scheduler.schedule(1, 1_400)).toBe(true);
    expect(scheduler.snapshot()).toEqual({ generation: 1, deadlineMs: 1_900 });
    vi.advanceTimersByTime(1_399);
    expect(elapsed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(elapsed).toEqual([1]);
  });

  it('ignores equal or later same-generation deadlines but lets a newer generation replace', () => {
    type Scheduler = {
      schedule: (generation: number, delayMs: number) => boolean;
      snapshot: () => { generation: number; deadlineMs: number } | null;
    };
    type SchedulerConstructor = new (onElapsed: (generation: number) => void) => Scheduler;
    const Scheduler = (
      forcedAnswerModule as unknown as { ForceFallbackScheduler?: SchedulerConstructor }
    ).ForceFallbackScheduler;
    expect(Scheduler).toBeTypeOf('function');
    if (!Scheduler) return;

    vi.useFakeTimers();
    vi.setSystemTime(0);
    const elapsed: number[] = [];
    const scheduler = new Scheduler((generation) => elapsed.push(generation));

    expect(scheduler.schedule(1, 1_400)).toBe(true);
    vi.advanceTimersByTime(500);
    expect(scheduler.schedule(1, 900)).toBe(false);
    expect(scheduler.schedule(1, 2_000)).toBe(false);
    expect(scheduler.snapshot()).toEqual({ generation: 1, deadlineMs: 1_400 });

    expect(scheduler.schedule(2, 2_500)).toBe(true);
    expect(scheduler.snapshot()).toEqual({ generation: 2, deadlineMs: 3_000 });
    vi.advanceTimersByTime(2_499);
    expect(elapsed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(elapsed).toEqual([2]);
  });

  it('does not merge 7.7 s delivery spacing when capture spacing exceeds 20 s', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused', () => 100_000);
    expect(
      coordinator.press(
        [
          {
            sequence: 1,
            text: 'Old delivered-late question.',
            source: 'system',
            capturedAtMs: 79_999,
            receivedAt: 92_300,
          },
          {
            sequence: 2,
            text: 'Current question.',
            source: 'system',
            capturedAtMs: 100_000,
            receivedAt: 100_000,
          },
        ],
        'system',
      ),
    ).toMatchObject({ action: 'submit', question: 'Current question.' });
  });

  it('deduplicates repeated finals by utterance id', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'unused', () => 10_000);
    expect(
      coordinator.press(
        [
          {
            sequence: 1,
            text: 'First delivery.',
            source: 'system',
            utteranceId: 'same-turn',
            capturedAtMs: 9_000,
          },
          {
            sequence: 2,
            text: 'Corrected delivery.',
            source: 'system',
            utteranceId: 'same-turn',
            capturedAtMs: 9_000,
          },
        ],
        'system',
      ),
    ).toMatchObject({ action: 'submit', question: 'Corrected delivery.' });
  });

  it('keeps only the current transcript-finalization request', () => {
    let nextId = 0;
    const coordinator = new LatestForcedAnswerCoordinator(() => `force-${++nextId}`);

    for (let index = 0; index < 100; index += 1) coordinator.press([], 'mic');

    expect(coordinator.snapshot().pendingRequestCount).toBe(1);
    coordinator.setPhase(100, 'error');
    expect(coordinator.snapshot().pendingRequestCount).toBe(0);
  });

  it('starts a typed question as a newer generation', () => {
    const coordinator = new LatestForcedAnswerCoordinator(() => 'old-flush');
    coordinator.press([], 'system');

    expect(coordinator.submitQuestion('What is contract testing?')).toMatchObject({
      action: 'submit',
      generation: 2,
      question: 'What is contract testing?',
    });
    expect(coordinator.snapshot()).toMatchObject({
      generation: 2,
      phase: 'waiting-first-token',
      pendingRequestCount: 0,
    });
    expect(coordinator.acceptEmpty('old-flush')).toEqual({ action: 'store-only' });
  });
});
