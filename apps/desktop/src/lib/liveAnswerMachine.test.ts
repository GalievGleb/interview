import { describe, expect, it } from 'vitest';
import { decideAnswerAction } from './liveAnswerMachine';

// Стейт-машина live-суфлёра: решение run/queue/skip при распознанном вопросе.
// Гонки смены вопроса на середине ответа — самый частый баг критического пути.
describe('decideAnswerAction', () => {
  const base = { question: 'Что такое REST?', locked: false, lastQuestion: '', lastCompleted: '' };

  it('свободно + новый вопрос → run', () => {
    expect(decideAnswerAction(base)).toEqual({ action: 'run' });
  });

  it('уже отвечён (== lastCompleted) → skip, даже если свободно', () => {
    expect(
      decideAnswerAction({ ...base, lastCompleted: 'Что такое REST?' }),
    ).toEqual({ action: 'skip', reason: 'already-answered' });
  });

  it('заблокировано + тот же вопрос, что стримится → skip (не рестартуем)', () => {
    expect(
      decideAnswerAction({ ...base, locked: true, lastQuestion: 'Что такое REST?' }),
    ).toEqual({ action: 'skip', reason: 'same-question-streaming' });
  });

  it('заблокировано + ДРУГОЙ содержательный вопрос → queue', () => {
    const d = decideAnswerAction({
      question: 'Чем PUT отличается от POST в контексте идемпотентности запросов?',
      locked: true,
      lastQuestion: 'Что такое REST и какие у него принципы построения API?',
      lastCompleted: '',
    });
    expect(d).toEqual({ action: 'queue' });
  });

  it('заблокировано + почти тот же вопрос (не стоит очереди) → skip', () => {
    // shouldQueueIncomingAnswer отсеивает мелкую доработку того же вопроса.
    const d = decideAnswerAction({
      question: 'Что такое REST',
      locked: true,
      lastQuestion: 'Что такое REST?',
      lastCompleted: '',
    });
    expect(d).toEqual({ action: 'skip', reason: 'not-queue-worthy' });
  });

  it('приоритет: already-answered проверяется РАНЬШЕ блокировки', () => {
    // Даже если заблокировано и вопрос совпадает с текущим — если он ещё и
    // завершён, это already-answered (первая ветка).
    const d = decideAnswerAction({
      question: 'Q',
      locked: true,
      lastQuestion: 'Q',
      lastCompleted: 'Q',
    });
    expect(d).toEqual({ action: 'skip', reason: 'already-answered' });
  });

  it('сценарий: Q1 отвечается, приходит Q2 → queue; Q1 завершился, Q2 запускается', () => {
    // Q2 приходит во время Q1
    const duringQ1 = decideAnswerAction({
      question: 'Расскажи про транзакции и уровни изоляции в базах данных',
      locked: true,
      lastQuestion: 'Что такое индекс в базе данных и когда он не используется?',
      lastCompleted: '',
    });
    expect(duringQ1.action).toBe('queue');

    // Q1 завершился (lastCompleted=Q1, lock снят), Q2 запускается из очереди
    const afterQ1 = decideAnswerAction({
      question: 'Расскажи про транзакции и уровни изоляции в базах данных',
      locked: false,
      lastQuestion: 'Что такое индекс в базе данных и когда он не используется?',
      lastCompleted: 'Что такое индекс в базе данных и когда он не используется?',
    });
    expect(afterQ1).toEqual({ action: 'run' });
  });
});
