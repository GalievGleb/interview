import { describe, expect, it } from 'vitest';
import {
  hasUnresolvedHhChatDraftFact,
  hhChatDecisionHelperText,
  mergeHhChatDecisionDrafts,
  prepareHhChatDecisionAnswer,
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

  it('never exposes unresolved model placeholders while hydrating a visible draft', () => {
    const hydrated = mergeHhChatDecisionDrafts({}, [{
      id: 'bgp-question',
      suggestedAnswer: [
        'К сожалению, у меня нет опыта работы с BGP и OSPF.',
        'Мой опыт включает [уточните: что именно нужно вписать], поэтому быстро разберусь.',
        'Готов изучить эти протоколы под задачи команды.',
      ].join(' '),
    }]);

    expect(hydrated).toEqual({
      'bgp-question': 'К сожалению, у меня нет опыта работы с BGP и OSPF. Готов изучить эти протоколы под задачи команды.',
    });
    expect(hasUnresolvedHhChatDraftFact(hydrated['bgp-question'])).toBe(false);
  });

  it('recognizes only unresolved fact placeholders that must not be sent', () => {
    expect(hasUnresolvedHhChatDraftFact('Релокацию [уточните: рассматриваете ли переезд].')).toBe(true);
    expect(hasUnresolvedHhChatDraftFact('[Укажите сумму и формат оплаты].')).toBe(true);
    expect(hasUnresolvedHhChatDraftFact('Готов рассмотреть релокацию после обсуждения условий.')).toBe(false);
  });

  it('removes an unresolved generated clause while preserving a complete sendable HR reply', () => {
    const answer = prepareHhChatDecisionAnswer([
      'К сожалению, у меня нет опыта работы с BGP и OSPF.',
      'Мой опыт включает [уточните: что именно нужно вписать], поэтому быстро разберусь.',
      'Готов изучить эти протоколы под задачи команды.',
    ].join(' '));

    expect(answer).toBe(
      'К сожалению, у меня нет опыта работы с BGP и OSPF. Готов изучить эти протоколы под задачи команды.',
    );
    expect(hasUnresolvedHhChatDraftFact(answer)).toBe(false);
  });

  it('does not turn a placeholder-only draft into an empty silent send', () => {
    expect(prepareHhChatDecisionAnswer('[укажите точный личный факт]')).toBe('');
  });

  it('shows helper copy only while a generated HR answer is still loading', () => {
    expect(hhChatDecisionHelperText(true, false)).toBe('Готовлю ответ по вашему резюме…');
    expect(hhChatDecisionHelperText(false, true)).toBe('');
    expect(hhChatDecisionHelperText(false, false)).toBe('');
  });
});
