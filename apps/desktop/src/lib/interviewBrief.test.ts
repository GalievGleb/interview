import { describe, expect, it } from 'vitest';
import type { InterviewCalendarEvent } from '../types/electron';
import {
  buildInterviewBrief,
  canReuseStoredVacancyContext,
  findMatchingQueueItem,
  findMatchingVacancySession,
} from './interviewBrief';
import type {
  ReadinessReport,
  SmokeReviewSession,
  VacancyAnalysis,
} from './vacancyReview/types';

const vacancyText = [
  'Qualitica развивает платформу контроля качества для крупных интернет-магазинов и банков.',
  'В команде 25 инженеров, продуктом пользуются компании по всей России.',
  'Требования: Python, Pytest, Playwright, API-тестирование, Jenkins и опыт построения автотестов.',
].join('\n');

function makeEvent(overrides: Partial<InterviewCalendarEvent> = {}): InterviewCalendarEvent {
  return {
    id: 'event-current',
    vacancyTitle: 'QA AUTO',
    companyName: 'Qualitica',
    type: 'technical',
    status: 'confirmed',
    startAt: '2030-08-10T04:00:00.000Z',
    endAt: '2030-08-10T05:00:00.000Z',
    source: 'manual',
    createdAt: '2030-08-01T00:00:00.000Z',
    updatedAt: '2030-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<VacancyAnalysis> = {}): VacancyAnalysis {
  return {
    id: 'analysis-1',
    vacancyText,
    vacancyCompany: 'ООО «Qualitica»',
    targetRole: 'Senior QA Automation Engineer',
    seniorityLevel: 'senior',
    language: 'ru',
    extractedRequirements: ['Python', 'Pytest', 'Playwright'],
    optionalSkills: [],
    competencies: [
      { name: 'Python', priority: 'high', expectedLevel: 'advanced', resumeMatch: 'strong', note: 'Подтверждено проектами' },
      { name: 'Playwright', priority: 'high', expectedLevel: 'advanced', resumeMatch: 'gap', note: 'Нужно подготовить практический пример' },
    ],
    interviewTopics: [{
      id: 'topic-1',
      title: 'Архитектура UI-автотестов',
      category: 'Automation',
      importance: 'high',
      expectedKnowledge: 'Page Object, фикстуры, параллельный запуск',
      sampleQuestions: ['Как устроен ваш фреймворк?'],
      vacancyEvidence: 'опыт построения автотестов',
      whyAsked: 'Ключевое требование роли',
    }],
    projectQuestions: [],
    riskAreas: ['Нет подтверждённого примера миграции на Playwright'],
    hasResume: true,
    hasLegend: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeReport(): ReadinessReport {
  return {
    overallScore: 78,
    status: 'almost_ready',
    topicScores: [],
    strengths: ['Сильный Python и API-автоматизация'],
    weakAreas: ['Мало практики с Playwright'],
    criticalGaps: ['Нет примера настройки параллельного запуска'],
    nextPracticePlan: ['Повторить фикстуры и воркеры Playwright'],
    generatedAt: Date.now(),
  };
}

function makeSession(overrides: Partial<SmokeReviewSession> = {}): SmokeReviewSession {
  return {
    id: 'session-1',
    vacancyAnalysisId: 'analysis-1',
    vacancyAnalysis: makeAnalysis(),
    status: 'completed',
    questions: [],
    answers: [],
    currentIndex: 0,
    startedAt: Date.now(),
    completedAt: Date.now(),
    report: makeReport(),
    ...overrides,
  };
}

describe('interview brief', () => {
  it('matches abbreviated roles and company names without legal-form noise', () => {
    const matching = makeSession();
    const wrongCompany = makeSession({
      id: 'session-wrong',
      vacancyAnalysis: makeAnalysis({ vacancyCompany: 'Другая компания' }),
      startedAt: Date.now() + 1000,
    });

    expect(findMatchingVacancySession(makeEvent(), [wrongCompany, matching])?.id).toBe('session-1');
    expect(findMatchingQueueItem(makeEvent(), [{
      key: 'vacancy-1',
      id: '1',
      platform: 'hh',
      title: 'QA Automation Engineer',
      company: 'ООО Qualitica',
      salary: '',
      url: 'https://hh.ru/vacancy/1',
      status: 'sent',
      addedAt: new Date().toISOString(),
    }])?.key).toBe('vacancy-1');
  });

  it('never borrows vacancy evidence from another company', () => {
    const wrongCompanySession = makeSession({
      vacancyAnalysis: makeAnalysis({ vacancyCompany: 'Другая компания' }),
    });
    const wrongCompanyQueueItem = {
      key: 'vacancy-wrong-company',
      id: '2',
      platform: 'hh' as const,
      title: 'QA Automation Engineer',
      company: 'Другая компания',
      salary: '',
      url: 'https://hh.ru/vacancy/2',
      status: 'sent' as const,
      addedAt: new Date().toISOString(),
    };

    expect(findMatchingVacancySession(makeEvent(), [wrongCompanySession])).toBeNull();
    expect(findMatchingQueueItem(makeEvent(), [wrongCompanyQueueItem])).toBeNull();
  });

  it('does not infer a vacancy for a manual calendar event with no link or description', () => {
    expect(canReuseStoredVacancyContext(makeEvent({
      source: 'manual',
      vacancyUrl: undefined,
      vacancyDescription: undefined,
    }))).toBe(false);
    expect(canReuseStoredVacancyContext(makeEvent({
      source: 'manual',
      vacancyUrl: 'https://hh.ru/vacancy/123',
    }))).toBe(true);
    expect(canReuseStoredVacancyContext(makeEvent({ source: 'hh' }))).toBe(true);
  });

  it('uses the completed vacancy review for readiness, strengths, gaps, and study plan', () => {
    const brief = buildInterviewBrief({
      event: makeEvent(),
      session: makeSession(),
      vacancyText,
    });

    expect(brief.readinessScore).toBe(78);
    expect(brief.readinessLabel).toBe('Почти готов');
    expect(brief.strengths).toContain('Сильный Python и API-автоматизация');
    expect(brief.weakAreas).toEqual(expect.arrayContaining([
      'Нет примера настройки параллельного запуска',
      'Мало практики с Playwright',
    ]));
    expect(brief.studyPlan).toContain('Повторить фикстуры и воркеры Playwright');
    expect(brief.companyOverview.join(' ')).toContain('платформу контроля качества');
  });

  it('shows only previous HR calls from the same company', () => {
    const previousHr = makeEvent({
      id: 'hr-same-company',
      type: 'hr',
      startAt: '2026-07-01T10:00:00.000Z',
      endAt: '2026-07-01T11:00:00.000Z',
      completedAt: '2026-07-01T11:00:00.000Z',
      outcome: {
        sessionId: 'call-1',
        headline: 'Обсудили формат работы и вилку.',
        facts: ['Команда распределённая'],
        conditions: ['Удалённая работа'],
        nextSteps: ['Техническое интервью'],
        openQuestions: [],
        createdAt: '2026-07-01T11:00:00.000Z',
      },
    });
    const technicalSameCompany = makeEvent({ id: 'technical-same-company', startAt: '2026-07-02T10:00:00.000Z', endAt: '2026-07-02T11:00:00.000Z' });
    const hrOtherCompany = makeEvent({ id: 'hr-other-company', type: 'hr', companyName: 'Другая компания', startAt: '2026-07-03T10:00:00.000Z', endAt: '2026-07-03T11:00:00.000Z' });

    const brief = buildInterviewBrief({
      event: makeEvent(),
      analysis: makeAnalysis(),
      vacancyText,
      calendarEvents: [previousHr, technicalSameCompany, hrOtherCompany],
    });

    expect(brief.previousHrCalls.map((call) => call.id)).toEqual(['hr-same-company']);
    expect(brief.previousHrCalls[0].details).toContain('Удалённая работа');
  });

  it('does not invent a readiness percentage when the candidate profile is unavailable', () => {
    const brief = buildInterviewBrief({
      event: makeEvent(),
      analysis: makeAnalysis({ hasResume: false, competencies: undefined }),
      vacancyText,
    });

    expect(brief.readinessScore).toBeNull();
    expect(brief.readinessLabel).toBe('Нужен профиль кандидата');
    expect(brief.readinessBasis).toContain('честно оценить готовность нельзя');
  });

  it('returns an evidence-free brief when the vacancy has no description', () => {
    const brief = buildInterviewBrief({
      event: makeEvent({ notes: 'Просто для теста' }),
      vacancyText: '',
      preparationNotes: ['Повторить неподтверждённую тему'],
    });

    expect(brief.hasVacancyDetails).toBe(false);
    expect(brief.readinessScore).toBeNull();
    expect(brief.readinessLabel).toBe('Нужны требования вакансии');
    expect(brief.likelyTopics).toEqual([]);
    expect(brief.strengths).toEqual([]);
    expect(brief.weakAreas).toEqual([]);
    expect(brief.studyPlan).toEqual([]);
    expect(brief.companyOverview).toEqual([]);
  });
});
