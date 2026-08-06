import { describe, expect, it } from 'vitest';
import { validateGeneratedHhCoverLetter } from './hhCoverLetter';

const strongLetter = `Здравствуйте!

В последние годы я занимаюсь автоматизацией тестирования на Python. Для вашей задачи особенно релевантен мой опыт с Pytest, Playwright и REST API: я разрабатывал и поддерживал UI- и API-автотесты, а также развивал тестовую инфраструктуру.

Отдельно вижу совпадение по CI/CD и качеству запусков. Я интегрировал автотесты в пайплайны, подключал Allure и разбирал нестабильные сценарии, поэтому смогу не только добавлять проверки, но и поддерживать надёжность всего набора тестов.

Мне интересна роль, где автоматизация рассматривается как инженерная система, а не как набор отдельных скриптов. Буду рад обсудить задачи команды и подробнее рассказать о своём опыте.`;

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
      }),
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
      }),
    ).toBeNull();
    expect(
      validateGeneratedHhCoverLetter({
        coverLetter: `${strongLetter}\n[укажите нужный опыт]`,
        canAutoFill: true,
        matches: [
          { vacancyNeed: 'Python', resumeEvidence: 'Python' },
          { vacancyNeed: 'API', resumeEvidence: 'API' },
        ],
      }),
    ).toBeNull();
    expect(
      validateGeneratedHhCoverLetter({
        coverLetter: strongLetter,
        canAutoFill: false,
        reason: 'Недостаточно подтверждённого опыта',
        matches: [],
      }),
    ).toBeNull();
  });
});
