import { describe, expect, it } from 'vitest';
import { matchScreeningOptionLabels, normalizeScreeningOption } from './hhScreeningQuestions';

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
});
