import { describe, expect, it } from 'vitest';
import {
  hasUnresolvedHhChatDraftFact,
  mergeHhChatDecisionDrafts,
} from './hhChatDecisionDrafts';

describe('HR chat decision drafts', () => {
  it('hydrates a generated suggestion once without overwriting the user edit', () => {
    const pending = [{ id: 'decision-1', suggestedAnswer: 'Черновик из резюме' }];

    const hydrated = mergeHhChatDecisionDrafts({}, pending);
    expect(hydrated).toEqual({ 'decision-1': 'Черновик из резюме' });

    const edited = mergeHhChatDecisionDrafts(
      { 'decision-1': 'Мой проверенный ответ' },
      [{ id: 'decision-1', suggestedAnswer: 'Новый ответ модели' }],
    );
    expect(edited).toEqual({ 'decision-1': 'Мой проверенный ответ' });
  });

  it('recognizes only unresolved fact placeholders that must not be sent', () => {
    expect(hasUnresolvedHhChatDraftFact('Релокацию [уточните: рассматриваете ли переезд].')).toBe(true);
    expect(hasUnresolvedHhChatDraftFact('[Укажите сумму и формат оплаты].')).toBe(true);
    expect(hasUnresolvedHhChatDraftFact('Готов рассмотреть релокацию после обсуждения условий.')).toBe(false);
  });
});
