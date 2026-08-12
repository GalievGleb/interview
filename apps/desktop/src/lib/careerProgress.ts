import type { DevelopmentProfile } from './api';
import type { SmokeReviewSession } from './vacancyReview/types';

export interface CareerProgressSummary {
  practiceSessions: number;
  scoredPracticeSessions: number;
  latestPractice: SmokeReviewSession | null;
  previousComparablePractice: SmokeReviewSession | null;
  practiceDelta: number | null;
  confirmedInterviewSessions: number;
  nextTrainingAction: string;
}

function roleKey(session: SmokeReviewSession): string {
  return session.vacancyAnalysis.targetRole.trim().toLocaleLowerCase('ru');
}

export function buildCareerProgress(
  sessions: SmokeReviewSession[],
  profile: DevelopmentProfile | null,
): CareerProgressSummary {
  const completed = sessions
    .filter((session) => session.status === 'completed')
    .sort((left, right) => (right.completedAt ?? right.startedAt) - (left.completedAt ?? left.startedAt));
  const scored = completed.filter((session) => Boolean(session.report));
  const latestPractice = scored[0] ?? null;
  const latestRole = latestPractice ? roleKey(latestPractice) : '';
  const previousComparablePractice = latestPractice
    ? scored.slice(1).find((session) => roleKey(session) === latestRole) ?? null
    : null;
  const practiceDelta = latestPractice?.report && previousComparablePractice?.report
    ? latestPractice.report.overallScore - previousComparablePractice.report.overallScore
    : null;
  const nextTrainingAction = latestPractice?.report?.nextPracticePlan[0]
    ?? latestPractice?.report?.topicScores.find((topic) => topic.score < 70)?.nextAction
    ?? '';

  return {
    practiceSessions: completed.length,
    scoredPracticeSessions: scored.length,
    latestPractice,
    previousComparablePractice,
    practiceDelta,
    confirmedInterviewSessions: profile?.analyzedSessions ?? 0,
    nextTrainingAction,
  };
}
