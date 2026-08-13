import { describe, expect, it } from 'vitest';
import {
  hhVacancyUrlFromInput,
  hhVacancyUrlFromStandaloneInput,
  mergeVacancyWithAdditionalContext,
} from './vacancyInput';

describe('vacancy input', () => {
  it('normalizes a standalone HH vacancy link', () => {
    expect(hhVacancyUrlFromStandaloneInput('  https://hh.ru/vacancy/132327563?from=share  '))
      .toBe('https://hh.ru/vacancy/132327563');
  });

  it('normalizes regional HH vacancy links used by shared vacancies', () => {
    expect(hhVacancyUrlFromInput('https://tula.hh.ru/vacancy/132327563'))
      .toBe('https://hh.ru/vacancy/132327563');
  });

  it('does not treat a Telegram conversation containing an HH link as a standalone link', () => {
    const telegramText = [
      'HR, 12:41',
      'Договорились на созвон во вторник в 11:00.',
      'Вакансия: https://hh.ru/vacancy/132327563',
      'Кандидат, 12:43',
      'Да, время подходит.',
    ].join('\n');

    expect(hhVacancyUrlFromInput(telegramText)).toBe('https://hh.ru/vacancy/132327563');
    expect(hhVacancyUrlFromStandaloneInput(telegramText)).toBe('');
  });

  it('keeps pasted HR context when the vacancy is also loaded from HH', () => {
    expect(mergeVacancyWithAdditionalContext(
      'QA Automation. Требования: Java и Python.',
      'HR: созвон во вторник в 11:00, этап — техническое интервью.',
    )).toBe([
      'QA Automation. Требования: Java и Python.',
      '',
      'Дополнительный контекст от HR:',
      'HR: созвон во вторник в 11:00, этап — техническое интервью.',
    ].join('\n'));
  });
});
