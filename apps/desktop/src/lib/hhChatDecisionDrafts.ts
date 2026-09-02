import type { HhChatPendingDecision } from '../types/electron';

type DecisionDraft = Pick<HhChatPendingDecision, 'id' | 'suggestedAnswer'>;

export function mergeHhChatDecisionDrafts(
  current: Record<string, string>,
  decisions: readonly DecisionDraft[],
): Record<string, string> {
  let next = current;
  for (const decision of decisions) {
    if (Object.prototype.hasOwnProperty.call(current, decision.id)) continue;
    const suggestedAnswer = prepareHhChatDecisionAnswer(decision.suggestedAnswer ?? '');
    if (!suggestedAnswer) continue;
    if (next === current) next = { ...current };
    next[decision.id] = suggestedAnswer;
  }
  return next;
}

export function hasUnresolvedHhChatDraftFact(value: string): boolean {
  return /\[(?:уточните|укажите|впишите|добавьте)[^\]]*\]/iu.test(value);
}

export function prepareHhChatDecisionAnswer(value: string): string {
  const sentences = value
    .replace(/\r\n?/g, '\n')
    .split(/\n+/u)
    .flatMap((line) => line.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && !hasUnresolvedHhChatDraftFact(sentence));

  return sentences.join(' ').replace(/\s+/gu, ' ').trim();
}

export function hhChatDecisionHelperText(
  preparing: boolean,
  hasSuggestedAnswer: boolean,
): string {
  return preparing && !hasSuggestedAnswer ? 'Готовлю ответ по вашему резюме…' : '';
}
