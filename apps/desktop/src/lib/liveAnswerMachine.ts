/**
 * Чистое РЕШЕНИЕ стейт-машины live-суфлёра: что делать с распознанным вопросом
 * — запустить ответ, поставить в очередь или пропустить.
 *
 * Вынесено из useLiveCopilot (ref-based, тяжело тестировать) без смены
 * поведения: тот же порядок проверок, теперь под юнит-тестами. Гонки при смене
 * вопроса на середине ответа — самый частый источник багов на критическом пути.
 */
import { shouldQueueIncomingAnswer } from './liveAnswerQueue';

export type AnswerDecision =
  | { action: 'run' }
  | { action: 'queue' }
  | { action: 'skip'; reason: 'already-answered' | 'same-question-streaming' | 'not-queue-worthy' };

export interface AnswerMachineInput {
  /** Разрешённый вопрос-кандидат (после нормализации/следования). */
  question: string;
  /** Идёт ли сейчас генерация ответа (streamLock). */
  locked: boolean;
  /** Вопрос текущего стрима (тот, что генерируется прямо сейчас). */
  lastQuestion: string;
  /** Последний завершённый вопрос (на него ответ уже отдан). */
  lastCompleted: string;
}

/**
 * Решение по входящему вопросу. Порядок критичен и совпадает с прежним inline-
 * кодом useLiveCopilot:
 *  1) тот же, что уже завершён → skip (не отвечаем дважды);
 *  2) заблокировано и совпадает с текущим стримом → skip (уже отвечаем на него);
 *  3) заблокировано и новый вопрос не стоит очереди → skip;
 *  4) заблокировано → queue (доотвечаем текущий, потом этот);
 *  5) свободно → run.
 */
export function decideAnswerAction(input: AnswerMachineInput): AnswerDecision {
  const { question, locked, lastQuestion, lastCompleted } = input;
  if (question === lastCompleted) return { action: 'skip', reason: 'already-answered' };
  if (locked && question === lastQuestion) {
    return { action: 'skip', reason: 'same-question-streaming' };
  }
  if (locked) {
    if (!shouldQueueIncomingAnswer(lastQuestion, question)) {
      return { action: 'skip', reason: 'not-queue-worthy' };
    }
    return { action: 'queue' };
  }
  return { action: 'run' };
}
