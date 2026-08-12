import { describe, expect, it } from 'vitest';
import { buildCareerProgress } from './careerProgress';
import type { DevelopmentProfile } from './api';
import type { SmokeReviewSession } from './vacancyReview/types';

function practice(id: string, role: string, score: number, completedAt: number): SmokeReviewSession {
  return {
    id,
    vacancyAnalysisId: `analysis-${id}`,
    vacancyAnalysis: { targetRole: role } as SmokeReviewSession['vacancyAnalysis'],
    status: 'completed',
    questions: [],
    answers: [],
    currentIndex: 0,
    startedAt: completedAt - 100,
    completedAt,
    report: {
      overallScore: score,
      status: score >= 70 ? 'ready' : 'weak',
      topicScores: [],
      strengths: [],
      weakAreas: [],
      criticalGaps: [],
      nextPracticePlan: [`Повторить ${role}`],
      generatedAt: completedAt,
    },
  };
}

describe('career progress', () => {
  it('compares only attempts for the same role', () => {
    const summary = buildCareerProgress([
      practice('latest', 'QA Automation', 68, 300),
      practice('other-role', 'Backend', 92, 200),
      practice('previous', 'QA Automation', 52, 100),
    ], null);

    expect(summary.latestPractice?.id).toBe('latest');
    expect(summary.previousComparablePractice?.id).toBe('previous');
    expect(summary.practiceDelta).toBe(16);
  });

  it('does not invent a trend from one attempt or another role', () => {
    const summary = buildCareerProgress([
      practice('latest', 'Frontend', 70, 200),
      practice('other', 'Backend', 30, 100),
    ], null);

    expect(summary.practiceDelta).toBeNull();
    expect(summary.previousComparablePractice).toBeNull();
  });

  it('keeps confirmed interviews separate from practice', () => {
    const profile = { analyzedSessions: 3 } as DevelopmentProfile;
    const summary = buildCareerProgress([practice('practice', 'QA', 60, 100)], profile);

    expect(summary.practiceSessions).toBe(1);
    expect(summary.confirmedInterviewSessions).toBe(3);
  });
});
