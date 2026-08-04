import { describe, expect, it } from 'vitest';
import {
  buildHhSearchUrl,
  normalizeHhAssistantConfig,
  normalizeHhVacancyUrl,
  renderCoverLetter,
  shouldExcludeVacancy,
} from './hhAssistantPolicy';

describe('HH browser assistant policy', () => {
  it('normalizes limits and user-entered lists', () => {
    const config = normalizeHhAssistantConfig({
      query: '  QA Automation  ',
      maxQueueSize: 999,
      maxPages: 0,
      excludedKeywords: [' Java ', 'java', ''],
      excludedEmployers: ['Example', ' example '],
    });

    expect(config.query).toBe('QA Automation');
    expect(config.maxQueueSize).toBe(100);
    expect(config.maxPages).toBe(1);
    expect(config.excludedKeywords).toEqual(['Java']);
    expect(config.excludedEmployers).toEqual(['Example']);
  });

  it('builds a normal HH search page URL without private API calls', () => {
    const url = new URL(
      buildHhSearchUrl(
        normalizeHhAssistantConfig({
          query: 'QA Automation',
          area: '1',
          experience: 'between3And6',
          salaryFrom: 200000,
          onlyWithSalary: true,
        }),
        2,
      ),
    );

    expect(`${url.origin}${url.pathname}`).toBe('https://hh.ru/search/vacancy');
    expect(url.searchParams.get('text')).toBe('QA Automation');
    expect(url.searchParams.get('area')).toBe('1');
    expect(url.searchParams.get('experience')).toBe('between3And6');
    expect(url.searchParams.get('salary')).toBe('200000');
    expect(url.searchParams.get('only_with_salary')).toBe('true');
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('accepts only HH vacancy links and removes tracking parameters', () => {
    expect(normalizeHhVacancyUrl('/vacancy/12345?from=serp')).toBe(
      'https://hh.ru/vacancy/12345',
    );
    expect(normalizeHhVacancyUrl('https://spb.hh.ru/vacancy/67890?query=test')).toBe(
      'https://spb.hh.ru/vacancy/67890',
    );
    expect(normalizeHhVacancyUrl('https://example.com/vacancy/12345')).toBe('');
    expect(normalizeHhVacancyUrl('javascript:alert(1)')).toBe('');
  });

  it('filters excluded employers and vacancy keywords case-insensitively', () => {
    const config = normalizeHhAssistantConfig({
      excludedKeywords: ['Java'],
      excludedEmployers: ['Example corp'],
    });

    expect(
      shouldExcludeVacancy(
        { id: '1', title: 'Java QA', company: 'Other', salary: '', url: 'https://hh.ru/1' },
        config,
      ),
    ).toBe('excluded_keyword');
    expect(
      shouldExcludeVacancy(
        {
          id: '2',
          title: 'QA Automation',
          company: 'EXAMPLE CORP',
          salary: '',
          url: 'https://hh.ru/2',
        },
        config,
      ),
    ).toBe('excluded_employer');
  });

  it('renders a cover letter template without executing arbitrary placeholders', () => {
    const result = renderCoverLetter(
      'Здравствуйте, {company}! Интересует вакансия {vacancy}. {unknown}',
      {
        id: '1',
        title: 'QA Automation',
        company: 'Skill Labs',
        salary: '',
        url: 'https://hh.ru/vacancy/1',
      },
    );

    expect(result).toBe(
      'Здравствуйте, Skill Labs! Интересует вакансия QA Automation. {unknown}',
    );
  });

  it('normalizes auto-apply fields within safe bounds', () => {
    const defaults = normalizeHhAssistantConfig({});
    expect(defaults.autoSend).toBe(true);
    expect(defaults.resumeTitleContains).toBe('');
    expect(defaults.delayBetweenSec).toBe(20);
    expect(defaults.dailyLimit).toBe(50);
    expect(defaults.autoRunDaily).toBe(false);
    expect(defaults.autoRunHour).toBe(10);

    const config = normalizeHhAssistantConfig({
      autoSend: false,
      resumeTitleContains: '  Senior QA  ',
      delayBetweenSec: 500,
      dailyLimit: 0,
      autoRunDaily: true,
      autoRunHour: 25,
    });
    expect(config.autoSend).toBe(false);
    expect(config.resumeTitleContains).toBe('Senior QA');
    expect(config.delayBetweenSec).toBe(120);
    expect(config.dailyLimit).toBe(1);
    expect(config.autoRunDaily).toBe(true);
    expect(config.autoRunHour).toBe(23);

    expect(
      normalizeHhAssistantConfig({ delayBetweenSec: 'abc', dailyLimit: -5, autoRunHour: -1 }),
    ).toMatchObject({ delayBetweenSec: 20, dailyLimit: 1, autoRunHour: 0 });
  });
});
