import { describe, expect, it } from 'vitest';
import {
  buildHhSearchQueries,
  buildHhSearchUrl,
  detectQaSearchProfile,
  isVacancyCompatibleWithSearchSchedule,
  isVacancyRelevantToSearchProfile,
  isVacancyRelevantToSearchQuery,
  normalizeHhAssistantConfig,
  normalizeHhVacancyUrl,
  rankHhResumeTitlesForVacancy,
  renderCoverLetter,
  shouldExcludeVacancy,
} from './hhAssistantPolicy';

describe('HH browser assistant policy', () => {
  it('selects a résumé per vacancy instead of forcing the default direction', () => {
    const resumes = ['QA Automation Engineer (Python)', 'Fullstack / Game Developer C#'];
    expect(rankHhResumeTitlesForVacancy('AQA инженер Python', resumes, [resumes[0]])[0]).toBe(resumes[0]);
    expect(rankHhResumeTitlesForVacancy('Junior Game Developer C#', resumes, [resumes[0]])[0]).toBe(resumes[1]);
    expect(rankHhResumeTitlesForVacancy('Fullstack разработчик', resumes, [resumes[0]])[0]).toBe(resumes[1]);
  });
  it('normalizes limits and user-entered lists', () => {
    const config = normalizeHhAssistantConfig({
      query: '  QA Automation  ',
      maxQueueSize: 999,
      maxPages: 0,
      excludedKeywords: [' Java ', 'java', ''],
      excludedEmployers: ['Example', ' example '],
    });

    expect(config.query).toBe('QA Automation');
    expect(config.includeRelatedQueries).toBe(true);
    expect(config.additionalQueries).toEqual([]);
    expect(config.maxQueueSize).toBe(999);
    expect(config.maxPages).toBe(1);
    expect(config.excludedKeywords).toEqual(['Java']);
    expect(config.excludedEmployers).toEqual(['Example']);
  });

  it('expands a QA Python search into close role names and keeps explicit directions', () => {
    const config = normalizeHhAssistantConfig({
      query: ' QA   FULLSTACK PYTHON ',
      includeRelatedQueries: true,
      additionalQueries: [' Junior Game Developer C# ', 'qa fullstack python'],
    });

    expect(buildHhSearchQueries(
      config,
      'QA Automation Engineer\nPython, Pytest, Playwright, API автотесты',
    )).toEqual([
      'QA FULLSTACK PYTHON',
      'QA Automation Python',
      'AQA Python',
      'SDET Python',
      'инженер по автоматизации тестирования Python',
      'Fullstack QA Python',
      'тестировщик-автоматизатор Python',
      'автоматизация тестирования Python',
      'Python QA',
      'QA Engineer Python',
      'Junior Game Developer C#',
    ]);
  });

  it('keeps a broad QA search manual when the selected resume is for manual testing', () => {
    const config = normalizeHhAssistantConfig({
      query: 'QA-инженер',
      includeRelatedQueries: true,
    });
    const manualResume = [
      'QA-инженер',
      'Ручное функциональное и регрессионное тестирование.',
      'Тест-кейсы, баг-репорты, Postman, SQL, DevTools.',
    ].join('\n');

    expect(detectQaSearchProfile(config.query, manualResume)).toBe('manual');
    expect(buildHhSearchQueries(config, manualResume)).toEqual([
      'QA-инженер',
      'Manual QA',
      'QA Engineer',
      'тестировщик',
      'инженер по тестированию',
    ]);
    expect(buildHhSearchQueries(config, manualResume)).not.toContain('QA Automation');
    expect(buildHhSearchQueries(config, manualResume)).not.toContain('AQA');
  });

  it('keeps a generic automation search on the Python stack selected in the resume', () => {
    const config = normalizeHhAssistantConfig({
      query: 'QA Automation engineer',
      includeRelatedQueries: true,
    });
    const resume = 'QA Automation Engineer\nPython, Pytest, Playwright, API автотесты.';

    expect(buildHhSearchQueries(config, resume)).toEqual([
      'QA Automation engineer',
      'QA Automation Python',
      'AQA Python',
      'SDET Python',
      'инженер по автоматизации тестирования Python',
      'тестировщик-автоматизатор Python',
      'автоматизация тестирования Python',
      'Python QA',
      'QA Engineer Python',
    ]);
  });

  it('exhaustively expands a Python developer profile across common HH role names', () => {
    const config = normalizeHhAssistantConfig({ query: 'Python разработчик', includeRelatedQueries: true });
    expect(buildHhSearchQueries(config, 'Backend Python developer\nDjango, FastAPI')).toEqual([
      'Python разработчик', 'Python Developer', 'Backend Python',
      'Backend разработчик Python', 'Django Developer', 'FastAPI Developer',
    ]);
  });

  it('rejects explicit unsupported-only stacks before they enter a Python queue', () => {
    const vacancy = (title: string, id = title) => ({
      id,
      title,
      company: 'Example',
      salary: '',
      url: `https://hh.ru/vacancy/${encodeURIComponent(id)}`,
    });
    const resume = 'QA Automation Engineer\nPython, Pytest, Playwright, API автотесты.';
    const query = 'QA Automation engineer';

    for (const title of [
      'QA Automation Java',
      'QA автоматизатор Джава',
      'Senior QA Automation JS/TS',
      'AQA C#/.NET',
      'iOS QA Automation Swift',
      'Тестировщик-автоматизатор 1С / Vanessa Automation',
      'QA Automation Go',
    ]) {
      expect(isVacancyRelevantToSearchProfile(vacancy(title), query, '', resume)).toBe(false);
    }

    expect(isVacancyRelevantToSearchProfile(
      vacancy('QA Automation Python'),
      query,
      'Python, Pytest и Playwright.',
      resume,
    )).toBe(true);
    expect(isVacancyRelevantToSearchProfile(
      vacancy('QA Automation Java or Python'),
      query,
      'JUnit или Pytest в зависимости от команды.',
      resume,
    )).toBe(true);
  });

  it('filters specialised automation, data and performance roles out of a manual QA search', () => {
    const vacancy = (title: string) => ({
      id: title,
      title,
      company: 'Example',
      salary: '',
      url: 'https://hh.ru/vacancy/1',
    });
    const resume = 'Manual QA инженер. Ручное тестирование, тест-кейсы, Postman и SQL.';

    expect(isVacancyRelevantToSearchProfile(
      vacancy('QA Automation Engineer'),
      'QA-инженер',
      '',
      resume,
    )).toBe(false);
    expect(isVacancyRelevantToSearchProfile(
      vacancy('Data QA Engineer'),
      'QA-инженер',
      '',
      resume,
    )).toBe(false);
    expect(isVacancyRelevantToSearchProfile(
      vacancy('Performance QA Engineer'),
      'QA-инженер',
      '',
      resume,
    )).toBe(false);
    expect(isVacancyRelevantToSearchProfile(
      vacancy('QA Engineer'),
      'QA-инженер',
      'Написание и поддержка автотестов на Pytest и Playwright.',
      resume,
    )).toBe(false);
    expect(isVacancyRelevantToSearchProfile(
      vacancy('QA Engineer / Тестировщик'),
      'QA-инженер',
      'Ручное тестирование web и mobile, регресс, API в Postman.',
      resume,
    )).toBe(true);
  });

  it('keeps Python automation vacancies from the HH home feed even when the title is generic', () => {
    const automationResume = 'QA Automation Engineer: Python, Pytest, Playwright, API автотесты.';
    const genericQa = {
      id: '136143010',
      title: 'Тестировщик-автоматизатор / QA',
      company: 'VisionLabs',
      salary: '',
      url: 'https://hh.ru/vacancy/136143010',
    };
    const explicitPython = {
      ...genericQa,
      id: '136144274',
      title: 'Middle Automation QA Engineer in Python',
      url: 'https://hh.ru/vacancy/136144274',
    };

    expect(isVacancyRelevantToSearchProfile(explicitPython, 'QA FULLSTACK PYTHON', '', automationResume)).toBe(true);
    expect(isVacancyRelevantToSearchProfile(genericQa, 'QA FULLSTACK PYTHON', '', automationResume)).toBe(false);
    expect(isVacancyRelevantToSearchProfile(
      genericQa,
      'QA FULLSTACK PYTHON',
      'Разработка автотестов на Python, Playwright и Docker.',
      automationResume,
    )).toBe(true);
    expect(isVacancyRelevantToSearchProfile(
      genericQa,
      'QA FULLSTACK PYTHON',
      'Ручное тестирование и написание тест-кейсов без автоматизации.',
      automationResume,
    )).toBe(false);
    expect(isVacancyRelevantToSearchProfile(
      genericQa,
      'QA FULLSTACK PYTHON',
      'Нагрузочное тестирование на Locust и k6; базовый Python для модификации тестов.',
      automationResume,
    )).toBe(true);
    expect(isVacancyCompatibleWithSearchSchedule(
      explicitPython,
      'remote',
      'Можно работать удалённо из любой точки мира.',
    )).toBe(true);
    expect(isVacancyCompatibleWithSearchSchedule(
      { ...genericQa, title: 'QA специалист (офис в Москве)' },
      'remote',
      'Работа в современном офисе рядом с метро.',
    )).toBe(false);
    expect(isVacancyCompatibleWithSearchSchedule(
      genericQa,
      'remote',
      'Формат работы: на месте работодателя или удалённо',
    )).toBe(true);
    expect(isVacancyCompatibleWithSearchSchedule(
      genericQa,
      'remote',
      'В описании формат работы не указан.',
    )).toBe(true);
    expect(isVacancyCompatibleWithSearchSchedule(
      genericQa,
      'remote',
      'Формат работы: на месте работодателя',
    )).toBe(false);
  });

  it('accepts the real Python AQA vacancy previously skipped for the selected resume', () => {
    const selectedResume = 'Постоянная работа, подработка Qa Fullstack engineer python 240 000 ₽ · Удалённо';
    const description = [
      'Разрабатывать, поддерживать и развивать автоматизированные тесты.',
      'Покрывать автотестами UI и API, интеграционные и E2E-сценарии.',
      'Обязательные требования: опыт автоматизированного тестирования на Python.',
      'Уверенное владение PyTest, Playwright и/или Selenium.',
      'Формат работы: удалённо или гибрид.',
    ].join(' ');

    expect(isVacancyRelevantToSearchProfile({
      id: '136348560',
      title: 'AQA Engineer (Тестировщик-автоматизатор)',
      company: 'ООО АФЛТ-Системс',
      salary: '',
      url: 'https://hh.ru/vacancy/136348560',
    }, 'QA Automation engineer', description, selectedResume)).toBe(true);
  });

  it('does not turn an unrelated role into QA or developer experience', () => {
    const config = normalizeHhAssistantConfig({
      query: 'Product manager',
      includeRelatedQueries: true,
      additionalQueries: ['Product owner'],
    });

    expect(buildHhSearchQueries(config)).toEqual(['Product manager', 'Product owner']);
  });

  it('keeps QA search results in the QA profession even when HH matched a description', () => {
    const vacancy = (title: string) => ({
      id: title,
      title,
      company: 'Example',
      salary: '',
      url: 'https://hh.ru/vacancy/1',
    });

    expect(isVacancyRelevantToSearchQuery(vacancy('Fullstack QA инженер (Python)'), 'QA FULLSTACK PYTHON')).toBe(true);
    expect(isVacancyRelevantToSearchQuery(vacancy('AQA инженер (Python)'), 'SDET Python')).toBe(true);
    expect(isVacancyRelevantToSearchQuery(vacancy('Бизнес аналитик'), 'QA Automation Python')).toBe(false);
    expect(isVacancyRelevantToSearchQuery(vacancy('DevOps Engineer Mid/Mid+'), 'AQA Python')).toBe(false);
    expect(isVacancyRelevantToSearchQuery(vacancy('Fullstack .NET Core / JS Software Engineer'), 'Fullstack QA Python')).toBe(false);
    expect(isVacancyRelevantToSearchQuery(vacancy('Старший разработчик Go, QA Portal'), 'QA Automation Python')).toBe(false);
    expect(isVacancyRelevantToSearchQuery(vacancy('Python-разработчик по автоматизации бизнес-процессов'), 'инженер по автоматизации тестирования Python')).toBe(false);
    expect(isVacancyRelevantToSearchQuery(vacancy('Инженер по информационной безопасности (автоматизация)/DevOps'), 'инженер по автоматизации тестирования Python')).toBe(false);
    expect(isVacancyRelevantToSearchQuery(vacancy('Data Quality Assurance Analyst'), 'QA Automation Python')).toBe(false);
    expect(isVacancyRelevantToSearchQuery(vacancy('Разработчик (системный аналитик, тестировщик) бортовых алгоритмов управления'), 'QA Automation Python')).toBe(false);
  });

  it('allows developer vacancies only through an explicit developer direction', () => {
    const vacancy = {
      id: '1',
      title: 'Python developer (Fullstack)',
      company: 'Леста Игры',
      salary: '',
      url: 'https://hh.ru/vacancy/1',
    };

    expect(isVacancyRelevantToSearchQuery(vacancy, 'QA FULLSTACK PYTHON')).toBe(false);
    expect(isVacancyRelevantToSearchQuery(vacancy, 'Fullstack Python Developer')).toBe(true);
    expect(isVacancyRelevantToSearchQuery(vacancy, 'Junior Game Developer C#')).toBe(true);
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
    expect(url.searchParams.getAll('search_field')).toEqual([
      'name',
      'company_name',
      'description',
    ]);
    expect(url.searchParams.get('enable_snippets')).toBe('true');
    expect(url.searchParams.get('page')).toBe('2');
  });

  it('accepts only HH vacancy links and removes tracking parameters', () => {
    expect(normalizeHhVacancyUrl('/vacancy/12345?from=serp')).toBe(
      'https://hh.ru/vacancy/12345',
    );
    expect(normalizeHhVacancyUrl('https://spb.hh.ru/vacancy/67890?query=test')).toBe(
      'https://spb.hh.ru/vacancy/67890',
    );
    expect(normalizeHhVacancyUrl(
      'https://hh.ru/applicant/vacancy_response?vacancyId=135252786&employerId=12054170',
    )).toBe('https://hh.ru/vacancy/135252786');
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
    expect(defaults.resumeTitles).toEqual([]);
    expect(defaults.delayBetweenSec).toBe(20);
    expect(defaults.area).toBe('');
    expect(defaults.schedule).toBe('remote');
    expect(defaults.maxQueueSize).toBe(5000);
    expect(defaults.maxPages).toBe(20);
    expect(defaults.dailyLimit).toBe(20);
    expect(defaults.autoRunDaily).toBe(false);
    expect(defaults.autoRunHour).toBe(10);

    const config = normalizeHhAssistantConfig({
      autoSend: false,
      resumeTitleContains: '  Senior QA  ',
      resumeTitles: [' QA Automation ', 'QA Automation', 'Backend QA'],
      delayBetweenSec: 500,
      dailyLimit: 0,
      autoRunDaily: true,
      autoRunHour: 25,
    });
    expect(config.autoSend).toBe(false);
    expect(config.resumeTitleContains).toBe('Senior QA');
    expect(config.resumeTitles).toEqual(['QA Automation', 'Backend QA']);
    expect(config.delayBetweenSec).toBe(120);
    expect(config.dailyLimit).toBe(1);
    expect(config.autoRunDaily).toBe(true);
    expect(config.autoRunHour).toBe(23);

    expect(
      normalizeHhAssistantConfig({ delayBetweenSec: 'abc', dailyLimit: -5, autoRunHour: -1 }),
    ).toMatchObject({ delayBetweenSec: 20, dailyLimit: 1, autoRunHour: 0 });
  });
});
