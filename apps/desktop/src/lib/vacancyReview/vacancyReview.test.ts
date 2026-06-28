import { describe, it, expect } from 'vitest';
import { extractTopics, detectRole, detectSeniority } from './topicExtraction';
import {
  analyzeVacancyMock,
  buildSmokePlan,
  evaluateAnswerMock,
  buildReadinessReport,
} from './vacancyReviewService';
import { readinessLabelFromScore, topicStatusFromScore } from './readiness';
import type { SmokeReviewSession } from './types';

const QA_VACANCY = `QA Automation Engineer (Middle)
Требования:
- Python, Pytest обязательно
- Playwright или Selenium для UI-тестов
- API testing (HTTPX/Requests), Swagger
- SQL, PostgreSQL
- CI/CD (GitLab CI), Docker
- Allure отчёты, Git
- Тест-дизайн, регрессионное и smoke тестирование`;

describe('topic extraction', () => {
  it('derives topics from the vacancy, not a generic list', () => {
    const { topics } = extractTopics(QA_VACANCY);
    const ids = topics.map((t) => t.id);
    expect(ids).toContain('python');
    expect(ids).toContain('pytest');
    expect(ids).toContain('api-testing');
    expect(ids).toContain('cicd');
    expect(ids).toContain('docker');
    // Each topic carries vacancy evidence.
    expect(topics.every((t) => t.vacancyEvidence.length > 0)).toBe(true);
  });

  it('detects role and seniority', () => {
    expect(detectRole(QA_VACANCY)).toMatch(/QA Automation/i);
    expect(detectSeniority(QA_VACANCY, 'QA Automation Engineer')).toBe('middle');
  });

  it('extracts no topics from empty text', () => {
    expect(extractTopics('').topics).toHaveLength(0);
  });
});

describe('smoke plan', () => {
  it('builds 8–15 questions grouped by topic, increasing difficulty', async () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const plan = buildSmokePlan(analysis);
    expect(plan.length).toBeGreaterThanOrEqual(8);
    expect(plan.length).toBeLessThanOrEqual(15);
    expect(plan[0].difficulty).toBe('easy');
    expect(plan[plan.length - 1].difficulty).toBe('hard');
    expect(plan.every((q) => analysis.interviewTopics.some((t) => t.id === q.topicId))).toBe(true);
  });
});

describe('evaluation + report', () => {
  it('scores a concrete answer higher than a vague one', async () => {
    const analysis = analyzeVacancyMock({
      vacancyText: QA_VACANCY,
      language: 'ru',
      resumeText: 'Python, Playwright, Docker, GitLab CI на проекте',
    });
    const plan = buildSmokePlan(analysis);
    const q = plan[0];
    const good = evaluateAnswerMock(
      q,
      'На проекте я настраивал запуск pytest в GitLab CI внутри Docker, артефакты и Allure-отчёты, разбирал падения по логам.',
      analysis,
    );
    const vague = evaluateAnswerMock(q, 'Ну, наверное, что-то делал, не знаю точно.', analysis);
    expect(good.score).toBeGreaterThan(vague.score);
  });

  it('flags overclaiming when there is no resume', async () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const plan = buildSmokePlan(analysis);
    const evalRes = evaluateAnswerMock(
      plan[0],
      'У меня огромный опыт, я постоянно настраивал всё в продакшене.',
      analysis,
    );
    expect(evalRes.overclaimed).toBe(true);
  });

  it('builds a readiness report with overall + topic scores', async () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const questions = buildSmokePlan(analysis);
    const session: SmokeReviewSession = {
      id: 's1',
      vacancyAnalysisId: analysis.id,
      vacancyAnalysis: analysis,
      status: 'in_progress',
      questions,
      currentIndex: questions.length - 1,
      startedAt: Date.now(),
      answers: questions.map((q) => ({
        questionId: q.id,
        text: 'На проекте я использовал pytest, Playwright, Docker и Allure, разбирал падения.',
        source: 'text' as const,
        skipped: false,
        evaluation: evaluateAnswerMock(q, 'pytest Playwright Docker Allure на проекте', analysis),
        answeredAt: Date.now(),
      })),
    };
    const report = buildReadinessReport(session);
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);
    expect(report.topicScores.length).toBeGreaterThan(0);
    expect(report.topicScores.every((t) => t.questionsAsked > 0)).toBe(true);
  });
});

describe('readiness thresholds', () => {
  it('maps scores to statuses/labels', () => {
    expect(topicStatusFromScore(80)).toBe('strong');
    expect(topicStatusFromScore(60)).toBe('medium');
    expect(topicStatusFromScore(40)).toBe('weak');
    expect(topicStatusFromScore(10)).toBe('critical');
    expect(readinessLabelFromScore(90)).toBe('strong');
    expect(readinessLabelFromScore(72)).toBe('ready');
    expect(readinessLabelFromScore(55)).toBe('almost_ready');
    expect(readinessLabelFromScore(35)).toBe('weak');
    expect(readinessLabelFromScore(10)).toBe('not_ready');
  });
});
