import { describe, expect, it } from 'vitest';
import { buildCandidateJourney, inferCandidatePath, type CandidateJourneySignals } from './candidateJourney';

const base: CandidateJourneySignals = {
  selectedPath: null,
  hasVacancy: false,
  hasResume: false,
  hasAnalysis: false,
  practiceAnswers: 0,
  practiceQuestions: 0,
  practiceCompleted: false,
  hasGrowthRole: false,
  hasGrowthProfile: false,
  hasEvidence: false,
};

describe('candidate journey', () => {
  it('does not assume that every new user starts with a vacancy', () => {
    expect(inferCandidatePath(base)).toBeNull();
    expect(buildCandidateJourney(base).headline).toBe('С чего вы начинаете сегодня?');
  });

  it('routes a vacancy-first user through resume, match, practice, application, and an employer response', () => {
    const missingResume = buildCandidateJourney({ ...base, selectedPath: 'vacancy', hasVacancy: true });
    expect(missingResume.action).toEqual({ label: 'Добавить резюме', to: '/documents?next=prepare' });
    expect(missingResume.steps.map((step) => step.label)).toEqual([
      'Вакансия', 'Резюме', 'Сопоставление', 'Практика', 'Отклик', 'Ответ HR',
    ]);

    const practice = buildCandidateJourney({
      ...base,
      selectedPath: 'vacancy',
      hasVacancy: true,
      hasResume: true,
      hasAnalysis: true,
      practiceAnswers: 3,
      practiceQuestions: 10,
      activeSessionId: 'session-1',
    });
    expect(practice.action).toEqual({ label: 'Продолжить практику', to: '/prepare?session=session-1' });
    expect(practice.body).toContain('3 из 10');

    const readyToApply = buildCandidateJourney({
      ...base,
      selectedPath: 'vacancy',
      hasVacancy: true,
      hasResume: true,
      hasAnalysis: true,
      practiceCompleted: true,
      hasEvidence: true,
      activeVacancyUrl: 'https://hh.ru/vacancy/123',
      activeSessionId: 'session-1',
    });
    expect(readyToApply.action.to).toContain('/applications?');
    expect(readyToApply.action.to).toContain('vacancyUrl=');

    const waitingForResponse = buildCandidateJourney({ ...base, selectedPath: 'vacancy', hasVacancy: true, hasResume: true, hasAnalysis: true, practiceCompleted: true, hasApplication: true, hasEvidence: true });
    expect(waitingForResponse.action.to).toBe('/applications?view=dialogs');
    expect(waitingForResponse.secondaryAction?.to).toBe('/history?view=growth');

    const responded = buildCandidateJourney({ ...base, selectedPath: 'vacancy', hasVacancy: true, hasResume: true, hasAnalysis: true, practiceCompleted: true, hasApplication: true, hasEmployerResponse: true });
    expect(responded.steps.at(-1)?.status).toBe('done');
    expect(responded.action.to).toBe('/applications?view=dialogs');
  });

  it('routes a user without a vacancy from resume to a goal and honest evidence', () => {
    const start = buildCandidateJourney({ ...base, selectedPath: 'profile' });
    expect(start.action.to).toBe('/documents?mode=baseline');
    expect(start.body).toContain('не станет оценкой');

    const goal = buildCandidateJourney({ ...base, selectedPath: 'profile', hasResume: true });
    expect(goal.action.to).toBe('/documents?mode=baseline&section=goal');

    const evidence = buildCandidateJourney({
      ...base,
      selectedPath: 'profile',
      hasResume: true,
      hasGrowthRole: true,
      hasGrowthProfile: true,
    });
    expect(evidence.action.to).toBe('/applications?mode=settings');
    expect(evidence.headline).toBe('Подтвердите навыки на практике.');

    const result = buildCandidateJourney({
      ...base,
      selectedPath: 'profile',
      hasResume: true,
      hasGrowthRole: true,
      hasGrowthProfile: true,
      hasEvidence: true,
    });
    expect(result.action.to).toBe('/history?view=growth');
    expect(result.steps.map((step) => step.label)).toEqual(['Резюме', 'Цель', 'Практика и интервью']);
  });

  it('never skips a missing resume just because a vacancy was already analyzed', () => {
    const journey = buildCandidateJourney({
      ...base,
      selectedPath: 'vacancy',
      hasVacancy: true,
      hasAnalysis: true,
      activeSessionId: 'session-2',
    });
    expect(journey.currentStep).toBe(1);
    expect(journey.action.to).toBe('/documents?next=prepare&session=session-2');
    expect(journey.secondaryAction?.to).toBe('/prepare?session=session-2');
  });

  it('does not mark later journey steps done before a missing prerequisite', () => {
    const journey = buildCandidateJourney({
      ...base,
      selectedPath: 'vacancy',
      hasVacancy: true,
      hasAnalysis: true,
      practiceCompleted: true,
    });

    expect(journey.steps.map((step) => step.status)).toEqual([
      'done',
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
  });
});
