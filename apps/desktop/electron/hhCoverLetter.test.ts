import { describe, expect, it } from 'vitest';
import {
  buildGroundedLocalHhCoverLetter,
  validateGeneratedHhCoverLetter,
} from './hhCoverLetter';

const strongLetter = `Здравствуйте!

В последние годы я занимаюсь автоматизацией тестирования на Python. Для вашей задачи особенно релевантен мой опыт с Pytest, Playwright и REST API: я разрабатывал и поддерживал UI- и API-автотесты, а также развивал тестовую инфраструктуру.

Отдельно вижу совпадение по CI/CD и качеству запусков. Я интегрировал автотесты в пайплайны, подключал Allure и разбирал нестабильные сценарии, поэтому смогу не только добавлять проверки, но и поддерживать надёжность всего набора тестов.

Мне интересна роль, где автоматизация рассматривается как инженерная система, а не как набор отдельных скриптов. Буду рад обсудить задачи команды и подробнее рассказать о своём опыте.`;

const pythonRequest = {
  vacancyTitle: 'QA Automation Engineer Python',
  vacancyCompany: 'Example',
  vacancyDescription: 'Python, Pytest, Playwright, REST API и CI/CD.',
  resumeText: 'QA Automation Python. Pytest, Playwright, REST API и CI/CD.',
  language: 'ru' as const,
};

describe('HH generated cover-letter guard', () => {
  it('accepts a grounded tailored letter with multiple explicit matches', () => {
    expect(
      validateGeneratedHhCoverLetter({
        coverLetter: strongLetter,
        canAutoFill: true,
        matches: [
          { vacancyNeed: 'Python и Pytest', resumeEvidence: 'Автотесты на Python/Pytest' },
          { vacancyNeed: 'CI/CD и Allure', resumeEvidence: 'Интеграция тестов и отчётов' },
        ],
      }, pythonRequest),
    ).toEqual({
      letter: strongLetter,
      matches: [
        { vacancyNeed: 'Python и Pytest', resumeEvidence: 'Автотесты на Python/Pytest' },
        { vacancyNeed: 'CI/CD и Allure', resumeEvidence: 'Интеграция тестов и отчётов' },
      ],
    });
  });

  it('rejects generic, ungrounded, and unfinished output', () => {
    expect(
      validateGeneratedHhCoverLetter({
        coverLetter: 'Здравствуйте! Меня заинтересовала ваша вакансия.',
        canAutoFill: true,
        matches: [],
      }, pythonRequest),
    ).toBeNull();
    expect(
      validateGeneratedHhCoverLetter({
        coverLetter: `${strongLetter}\n[укажите нужный опыт]`,
        canAutoFill: true,
        matches: [
          { vacancyNeed: 'Python', resumeEvidence: 'Python' },
          { vacancyNeed: 'API', resumeEvidence: 'API' },
        ],
      }, pythonRequest),
    ).toBeNull();
    expect(
      validateGeneratedHhCoverLetter({
        coverLetter: `${strongLetter}\n\nС уважением,\n[Ваше имя]`,
        canAutoFill: true,
        matches: [
          { vacancyNeed: 'Python', resumeEvidence: 'Python' },
          { vacancyNeed: 'API', resumeEvidence: 'API' },
        ],
      }, pythonRequest),
    ).toBeNull();
    expect(
      validateGeneratedHhCoverLetter({
        coverLetter: `${strongLetter}\n\nBest regards,\nIvan`,
        canAutoFill: true,
        matches: [
          { vacancyNeed: 'Python', resumeEvidence: 'Python' },
          { vacancyNeed: 'API', resumeEvidence: 'API' },
        ],
      }, pythonRequest),
    ).toBeNull();
    expect(
      validateGeneratedHhCoverLetter({
        coverLetter: strongLetter,
        canAutoFill: false,
        reason: 'Недостаточно подтверждённого опыта',
        matches: [],
      }, pythonRequest),
    ).toBeNull();
  });

  it('builds a local fallback only from skills present in both vacancy and résumé', () => {
    const response = buildGroundedLocalHhCoverLetter({
      vacancyTitle: 'QA Automation Engineer',
      vacancyCompany: 'Example',
      vacancyDescription: 'Нужны Python, Pytest, REST API, Docker и Kubernetes.',
      resumeText: 'Автоматизация на Python и Pytest. API-тесты REST. Работал с Docker.',
      language: 'ru',
    });

    expect(response.canAutoFill).toBe(true);
    expect(response.model).toBe('local-grounded-v1');
    expect(response.coverLetter).toContain('Python, Pytest, REST API и Docker');
    expect(response.coverLetter).not.toContain('Kubernetes');
    expect(validateGeneratedHhCoverLetter(response, pythonRequest)).not.toBeNull();
  });

  it('refuses the local fallback when fewer than two skills are grounded', () => {
    const response = buildGroundedLocalHhCoverLetter({
      vacancyTitle: 'QA Automation Engineer',
      vacancyCompany: 'Example',
      vacancyDescription: 'Нужны Python и Kubernetes.',
      resumeText: 'Автоматизация на Python и Pytest.',
      language: 'ru',
    });

    expect(response.canAutoFill).toBe(false);
    expect(response.coverLetter).toBe('');
    expect(response.failureKind).toBe('skill_mismatch');
  });

  it('rejects local and AI letters for an unsupported core stack despite secondary matches', () => {
    const javaVacancyForPythonResume = {
      vacancyTitle: 'QA Automation Engineer Java',
      vacancyCompany: 'Example',
      vacancyDescription: 'Основной стек Java и JUnit. Также нужны REST API, Docker и CI/CD.',
      resumeText: 'QA Automation Python. REST API, Docker, CI/CD, Pytest и Playwright.',
      language: 'ru' as const,
    };
    const local = buildGroundedLocalHhCoverLetter(javaVacancyForPythonResume);

    expect(local).toMatchObject({
      canAutoFill: false,
      failureKind: 'skill_mismatch',
      matches: [],
    });
    expect(validateGeneratedHhCoverLetter({
      coverLetter: strongLetter,
      canAutoFill: true,
      matches: [
        { vacancyNeed: 'REST API', resumeEvidence: 'REST API' },
        { vacancyNeed: 'Docker и CI/CD', resumeEvidence: 'Docker и CI/CD' },
      ],
    }, javaVacancyForPythonResume)).toBeNull();
  });
});
