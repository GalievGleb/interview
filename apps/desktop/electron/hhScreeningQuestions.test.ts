import { describe, expect, it } from 'vitest';
import {
  matchScreeningOptionLabels,
  normalizeScreeningOption,
  parseHhScreeningAnswersResponse,
  screeningQuestionKey,
} from './hhScreeningQuestions';

describe('HH screening question helpers', () => {
  it('normalizes punctuation and Russian ё for exact option matching', () => {
    expect(normalizeScreeningOption('  Всё готово! ')).toBe('все готово');
  });

  it('selects only exact options returned by the model', () => {
    expect(matchScreeningOptionLabels(
      { answer: '', selectedOptions: ['Да'] },
      ['Да', 'Нет', 'Затрудняюсь ответить'],
      false,
    )).toEqual(['Да']);
  });

  it('supports multiple selected options without fuzzy accidental matches', () => {
    expect(matchScreeningOptionLabels(
      { answer: '', selectedOptions: ['Jira', 'Confluence'] },
      ['Jira', 'Confluence', 'Java'],
      true,
    )).toEqual(['Jira', 'Confluence']);
    expect(matchScreeningOptionLabels(
      { answer: 'Да, работал', selectedOptions: [] },
      ['Да', 'Нет'],
      false,
    )).toEqual([]);
  });

  it('uses an exact normalized question key without broadening its meaning', () => {
    expect(screeningQuestionKey('Готовы ли вы к релокации в Саудовскую Аравию?'))
      .toBe(screeningQuestionKey('  Готовы ли вы к релокации в Саудовскую Аравию! '));
    expect(screeningQuestionKey('Готовы ли вы к релокации в Саудовскую Аравию?'))
      .not.toBe(screeningQuestionKey('Готовы ли вы к релокации в ОАЭ?'));
  });

  it('downgrades legacy or malformed autofill responses without provenance', () => {
    const response = parseHhScreeningAnswersResponse({
      answers: [
        { id: 'legacy', answer: 'Да', selectedOptions: [], canAutoFill: true },
        {
          id: 'wrong-boolean', answer: 'Да', selectedOptions: [], canAutoFill: 'true',
          sourceType: 'knowledge', evidenceQuote: '',
        },
        {
          id: 'missing-evidence', answer: 'Работал с Jira', selectedOptions: [], canAutoFill: true,
          sourceType: 'resume', evidenceQuote: '',
        },
      ],
    });

    expect(response.answers).toHaveLength(3);
    expect(response.answers.every((answer) => answer.canAutoFill === false)).toBe(true);
  });

  it('keeps only contract-complete backend answers eligible for autofill', () => {
    const response = parseHhScreeningAnswersResponse({
      model: 'test-model',
      answers: [
        {
          id: 'resume', answer: 'Работал с Jira', selectedOptions: [], canAutoFill: true,
          sourceType: 'resume', evidenceQuote: 'Использовал Jira в проекте',
        },
        {
          id: 'knowledge', answer: 'Использую граничные значения', selectedOptions: [], canAutoFill: true,
          sourceType: 'knowledge', evidenceQuote: '',
        },
        {
          id: 'confirmed', answer: 'Красноярск', selectedOptions: [], canAutoFill: true,
          sourceType: 'confirmed', evidenceQuote: 'Красноярск',
        },
      ],
    });

    expect(response.model).toBe('test-model');
    expect(response.answers.map((answer) => answer.canAutoFill)).toEqual([true, true, true]);
  });
});
