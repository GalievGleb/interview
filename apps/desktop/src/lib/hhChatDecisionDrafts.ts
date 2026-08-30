import type { HhChatPendingDecision } from '../types/electron';

type DecisionDraft = Pick<HhChatPendingDecision, 'id' | 'suggestedAnswer'>;

export function mergeHhChatDecisionDrafts(
  current: Record<string, string>,
  decisions: readonly DecisionDraft[],
): Record<string, string> {
  let next = current;
  for (const decision of decisions) {
    if (Object.prototype.hasOwnProperty.call(current, decision.id)) continue;
    const suggestedAnswer = decision.suggestedAnswer?.trim();
    if (!suggestedAnswer) continue;
    if (next === current) next = { ...current };
    next[decision.id] = suggestedAnswer;
  }
  return next;
}

export function hasUnresolvedHhChatDraftFact(value: string): boolean {
  return /\[(?:уточните|укажите|впишите|добавьте)[^\]]*\]/iu.test(value);
}
