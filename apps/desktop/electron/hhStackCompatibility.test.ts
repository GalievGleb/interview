import { describe, expect, it } from 'vitest';
import {
  evaluateHhStackCompatibility,
  inferHhPrimaryStacks,
} from './hhStackCompatibility';

const pythonResume = [
  'QA Automation Engineer',
  'Python, Pytest, Playwright. Разработка API- и UI-автотестов.',
].join('\n');

describe('HH primary-stack compatibility', () => {
  it('infers Python from the selected resume for a generic QA query', () => {
    expect(inferHhPrimaryStacks('QA Automation engineer', pythonResume)).toEqual(['python']);
  });

  it.each([
    ['Java-only', 'QA Automation Engineer Java', 'Selenide, JUnit, REST Assured.'],
    ['Java-only in Russian', 'QA автоматизатор Джава', 'Selenide и JUnit.'],
    ['JavaScript/TypeScript-only', 'Senior QA Automation JS/TS', 'Cypress и TypeScript.'],
    ['C#-only', 'AQA Engineer C#/.NET', 'NUnit и API-тестирование.'],
    ['Swift-only', 'iOS QA Automation Swift', 'XCTest и мобильные автотесты.'],
    ['1C-only', 'Тестировщик-автоматизатор 1С', 'Vanessa Automation.'],
    ['Go-only', 'QA Automation Go', 'Автотесты сервисов на Golang.'],
  ])('rejects an explicit unsupported %s stack', (_caseName, vacancyTitle, vacancyDescription) => {
    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle,
      vacancyDescription,
    })).toMatchObject({
      compatible: false,
      candidateStacks: ['python'],
    });
  });

  it('accepts Python and mixed Java-or-Python vacancies', () => {
    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle: 'QA Automation Engineer Python',
      vacancyDescription: 'Pytest и Playwright.',
    }).compatible).toBe(true);

    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle: 'QA Automation Engineer — Java or Python',
      vacancyDescription: 'Команды автоматизации используют JUnit и Pytest.',
    })).toMatchObject({
      compatible: true,
      candidateStacks: ['python'],
      vacancyStacks: ['python', 'java'],
    });
  });

  it('lets an explicit Java-or-Python body override a Java-only title', () => {
    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle: 'QA Automation Engineer Java',
      vacancyDescription: 'Стек автоматизации: Java или Python. Используем JUnit или Pytest.',
    })).toMatchObject({
      compatible: true,
      candidateStacks: ['python'],
      vacancyStacks: ['python', 'java'],
    });
  });

  it('uses the description when a vacancy title has no explicit stack', () => {
    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle: 'QA Automation Engineer',
      vacancyDescription: 'Основной стек: Java, Selenide, JUnit. Разработка автотестов API.',
    }).compatible).toBe(false);

    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle: 'QA Automation Engineer',
      vacancyDescription: 'Основной стек: Python, Pytest и Playwright.',
    }).compatible).toBe(true);
  });

  it('keeps a generic vacancy eligible when it declares no core stack', () => {
    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle: 'QA Automation Engineer',
      vacancyDescription: 'API, Docker, CI/CD и UI-автоматизация.',
    }).compatible).toBe(true);
  });

  it('ignores a negated Java mention in an otherwise generic title', () => {
    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle: 'QA Automation Engineer — Java не требуется',
      vacancyDescription: 'API, Docker, CI/CD и UI-автоматизация.',
    })).toMatchObject({
      compatible: true,
      candidateStacks: ['python'],
      vacancyStacks: [],
    });
  });

  it('does not treat the product backend language as the automation requirement', () => {
    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle: 'QA Automation Engineer',
      vacancyDescription: 'Продуктовый backend написан на Java, требуется опыт тестирования API и UI.',
    })).toMatchObject({
      compatible: true,
      candidateStacks: ['python'],
      vacancyStacks: [],
    });
  });

  it('rejects an explicit unsupported-only primary stack in the description', () => {
    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation engineer',
      resumeContext: pythonResume,
      vacancyTitle: 'QA Automation Engineer',
      vacancyDescription: 'Основной стек Java/JUnit. Пишем API- и UI-автотесты.',
    })).toMatchObject({
      compatible: false,
      candidateStacks: ['python'],
      vacancyStacks: ['java'],
    });
  });

  it('fails closed when an explicit query conflicts with the selected resume', () => {
    expect(inferHhPrimaryStacks(
      'QA Automation Java',
      'QA Automation Python\nPytest, Playwright',
    )).toEqual([]);
    expect(evaluateHhStackCompatibility({
      searchQuery: 'QA Automation Java',
      resumeContext: 'QA Automation Python\nPytest, Playwright',
      vacancyTitle: 'QA Automation Java',
    }).compatible).toBe(false);
  });
});
