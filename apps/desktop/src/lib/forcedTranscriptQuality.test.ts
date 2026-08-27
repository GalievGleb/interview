import { describe, expect, it, vi } from 'vitest';
import * as liveCopilotModule from '../hooks/useLiveCopilot';
import { LatestForcedAnswerCoordinator } from './latestForcedAnswer';
import {
  evaluateForcedFinalTranscript,
  evaluateForcedTranscript,
} from './forcedTranscriptQuality';

describe('evaluateForcedTranscript', () => {
  it.each([
    'Hücum',
    'No dobrze',
    'Flibbertigibbet',
    'No dobrze э',
    'Hücum ы',
    'No dobrze это',
    'Hücum это',
    'No это',
    'Hücum почему',
    'почему Hücum',
    'Hücum расскажи',
    'No какие',
    '...',
    '###',
    '123',
  ])(
    'rejects non-Russian Latin noise in a Russian live session: %s',
    (transcript) => {
      expect(evaluateForcedTranscript(transcript, 'ru')).toEqual({
        eligible: false,
        reason: 'forced_text_language_mismatch',
      });
    },
  );

  it.each([
    'SQL',
    'API',
    'Docker',
    '.NET',
    'C#',
    'C++',
    'CI/CD',
    'Node.js',
    'SQL/API',
    'Docker/Playwright',
    'PostgreSQL',
    'Go',
    'Playwright',
    'Сколько?',
    'Что делает yield?',
    'Как работает API?',
    'Что такое .NET?',
    'Что такое Node.js?',
    'Опыт с C#',
    'Как Playwright работает с Node.js?',
    'PostgreSQL и SQL: в чём разница?',
    'Опыт с C# и C++?',
    'CI/CD в Go-проекте?',
    'Почему Docker используют в CI/CD?',
    'Работаю с SQL/API',
    'Использую Docker/Playwright',
    'Расскажи про PostgreSQL и Node.js',
    'Какие API проверяет Playwright?',
    'Чем Promise отличается от Observable?',
    'Как React использует JavaScript?',
    'Как OpenTelemetry работает с экспортерами?',
  ])('keeps short technical and Russian questions eligible: %s', (transcript) => {
    expect(evaluateForcedTranscript(transcript, 'ru')).toEqual({ eligible: true });
  });

  it('keeps a long Russian interview question when one STT fragment switches language', () => {
    const transcript = [
      'У нас есть POST-запрос, который оформляет заказ на сайте.',
      'На входе тело запроса с отправлениями, адресом и способом оплаты.',
      'Было бы интересно накидать тест-план проверок для такого метода.',
      'Jediné našli na',
      'Платежный метод может быть банковской картой или бонусами на балансе.',
      'Можно начать с чек-листа, а потом расширить его до конкретных кейсов.',
      'Как бы ты подходил к тестированию этой задачи?',
    ].join(' ');

    expect(evaluateForcedTranscript(transcript, 'ru')).toEqual({ eligible: true });
  });

  it.each([
    'Почему Flibbertigibbet?',
    'Flibbertigibbet расскажи',
    'Hucum это',
  ])('rejects an unknown Latin fragment without enough Russian context: %s', (transcript) => {
    expect(evaluateForcedTranscript(transcript, 'ru')).toEqual({
      eligible: false,
      reason: 'forced_text_language_mismatch',
    });
  });

  it.each(['SQL/Hücum', 'Docker/No'])(
    'rejects a delimiter-joined identifier with an unknown component: %s',
    (transcript) => {
      expect(evaluateForcedTranscript(transcript, 'ru')).toEqual({
        eligible: false,
        reason: 'forced_text_language_mismatch',
      });
    },
  );

  it('does not apply the Russian-script gate to an English live session', () => {
    expect(evaluateForcedTranscript('What is Docker?', 'en')).toEqual({ eligible: true });
  });

  it('rejects a merged forced question when its finalized prefix is garbage', () => {
    type SubmitDecision = {
      action: 'submit';
      generation: number;
      sequence: number;
      question: string;
    };
    type Dispatcher = (
      decision: SubmitDecision,
      language: string,
      handlers: {
        prepare: () => void;
        reject: (question: string, generation: number, reason: string) => void;
        routeVisualToScreen: (question: string, generation: number) => boolean;
        askQuestion: (question: string, generation: number) => void;
      },
    ) => 'rejected' | 'screen' | 'text';
    const dispatch = (
      liveCopilotModule as unknown as { dispatchForcedSttSubmission?: Dispatcher }
    ).dispatchForcedSttSubmission;
    expect(dispatch).toBeTypeOf('function');
    if (!dispatch) return;

    const coordinator = new LatestForcedAnswerCoordinator(() => 'force-current', () => 100_000);
    expect(
      coordinator.press(
        [
          {
            sequence: 1,
            text: 'Hücum',
            source: 'system',
            capturedAtMs: 99_000,
          },
        ],
        'system',
        true,
      ),
    ).toMatchObject({ action: 'flush', requestId: 'force-current' });
    const decision = coordinator.acceptFinal(
      {
        sequence: 2,
        text: 'Сколько?',
        source: 'system',
        capturedAtMs: 100_000,
      },
      'force-current',
    );
    expect(decision).toMatchObject({
      action: 'submit',
      question: 'Hücum Сколько?',
    });
    if (decision.action !== 'submit') return;

    const prepare = vi.fn();
    const reject = vi.fn();
    const routeVisualToScreen = vi.fn(() => false);
    const askQuestion = vi.fn();
    expect(
      dispatch(decision, 'ru', {
        prepare,
        reject,
        routeVisualToScreen,
        askQuestion,
      }),
    ).toBe('rejected');
    expect(reject).toHaveBeenCalledWith(
      'Hücum Сколько?',
      decision.generation,
      'forced_text_language_mismatch',
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(routeVisualToScreen).not.toHaveBeenCalled();
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it('leaves a current-ID final from the wrong source to the coordinator', () => {
    expect(
      evaluateForcedFinalTranscript(
        'Hücum',
        'ru',
        'current-force',
        'current-force',
        'mic',
        'system',
        99_000,
        100_000,
      ),
    ).toEqual({ action: 'defer-to-coordinator' });
  });

  it('leaves a stale current-ID final to the coordinator', () => {
    expect(
      evaluateForcedFinalTranscript(
        'Hücum',
        'ru',
        'current-force',
        'current-force',
        'system',
        'system',
        79_999,
        100_000,
      ),
    ).toEqual({ action: 'defer-to-coordinator' });
  });

  it('rejects fresh garbage owned by the current source and request', () => {
    expect(
      evaluateForcedFinalTranscript(
        'Hücum',
        'ru',
        'current-force',
        'current-force',
        'system',
        'system',
        80_000,
        100_000,
      ),
    ).toEqual({
      action: 'reject',
      reason: 'forced_text_language_mismatch',
    });
  });

  it('allows fresh technical text owned by the current source and request', () => {
    expect(
      evaluateForcedFinalTranscript(
        'Playwright',
        'ru',
        'current-force',
        'current-force',
        'system',
        'system',
        80_000,
        100_000,
      ),
    ).toEqual({ action: 'eligible' });
  });
});
