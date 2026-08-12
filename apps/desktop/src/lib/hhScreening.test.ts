import { describe, expect, it } from 'vitest';
import {
  isHhAiQuotaMessage,
  isHhScreeningAnswerComplete,
  hhScreeningSemanticKey,
  summarizePendingHhScreening,
} from './hhScreening';
import type { HhQueueItem } from '../types/electron';

function vacancy(id: string, prompt: string, assistantReason?: string): HhQueueItem {
  return {
    key: `hh:${id}`,
    platform: 'hh',
    id,
    title: 'QA',
    company: 'Company',
    salary: '',
    url: `https://hh.ru/vacancy/${id}`,
    status: 'needs_input',
    addedAt: new Date().toISOString(),
    pendingQuestions: [{ id: `q-${id}`, prompt, kind: 'text', options: [], required: true, assistantReason }],
  };
}

describe('HH pending screening summary', () => {
  it('accepts short yes/no text as a complete employer answer', () => {
    const textQuestion = { kind: 'text' as const };
    expect(isHhScreeningAnswerComplete(textQuestion, 'Нет', [])).toBe(true);
    expect(isHhScreeningAnswerComplete(textQuestion, 'Да', [])).toBe(true);
    expect(isHhScreeningAnswerComplete(textQuestion, '   ', [])).toBe(false);
  });

  it('counts repeated employer prompts once', () => {
    const summary = summarizePendingHhScreening([
      vacancy('1', 'Где вы живёте?'),
      vacancy('2', '  ГДЕ Вы живете? '),
    ]);
    expect(summary.rawCount).toBe(2);
    expect(summary.uniqueCount).toBe(1);
  });

  it('counts Russian relocation as one preference but keeps abroad separate', () => {
    const summary = summarizePendingHhScreening([
      vacancy('1', 'Готовы ли вы к переезду в Рязань?'),
      vacancy('2', 'Готовы ли вы к переезду в Йошкар-Олу?'),
      vacancy('3', 'Готовы ли вы к релокации в Саудовскую Аравию?'),
    ]);
    expect(summary.rawCount).toBe(3);
    expect(summary.uniqueCount).toBe(2);
    expect(hhScreeningSemanticKey('Переезд в Рязань')).not.toBe(hhScreeningSemanticKey('Релокация в Саудовскую Аравию'));
  });

  it('keeps an unrecognized relocation destination isolated', () => {
    const summary = summarizePendingHhScreening([
      vacancy('1', 'Готовы ли вы к переезду в Пуэрто-Вальярту?'),
      vacancy('2', 'Готовы ли вы к переезду в Рязань?'),
    ]);
    expect(summary.uniqueCount).toBe(2);
  });

  it('separates an AI quota failure from a missing candidate fact', () => {
    const summary = summarizePendingHhScreening([
      vacancy('1', 'Ваш опыт?', 'Месячный лимит токенов тарифа исчерпан'),
      vacancy('2', 'Готовы к релокации?', 'Нужен подтверждённый ответ пользователя'),
    ]);
    expect(summary.quotaLimitedCount).toBe(1);
    expect(summary.missingFactCount).toBe(1);
    expect(isHhAiQuotaMessage('Лимит обновится 1-го числа')).toBe(true);
  });
});
