import { useCallback, useState } from 'react';
import {
  analyzeVacancy,
  buildFollowUpRound,
  buildReadinessReport,
  buildSmokePlan,
  evaluateAnswer,
} from './vacancyReviewService';
import { saveSession } from './vacancyReviewStore';
import type { SmokeReviewSession, VacancyReviewInput } from './types';

export type ReviewPhase = 'setup' | 'analyzing' | 'analysis' | 'interview' | 'report';

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}`;

/** Drives the whole Vacancy Smoke Review flow; persists each step. */
export function useVacancyReview(initial?: SmokeReviewSession | null) {
  const [phase, setPhase] = useState<ReviewPhase>(
    initial ? (initial.status === 'completed' ? 'report' : 'interview') : 'setup',
  );
  const [session, setSession] = useState<SmokeReviewSession | null>(initial ?? null);
  const [error, setError] = useState('');
  const [evaluating, setEvaluating] = useState(false);

  const persist = useCallback((next: SmokeReviewSession) => {
    setSession(next);
    saveSession(next);
  }, []);

  const analyze = useCallback(async (input: VacancyReviewInput) => {
    setError('');
    if (!input.vacancyText.trim()) {
      setError('Вставьте текст вакансии.');
      return;
    }
    setPhase('analyzing');
    try {
      const analysis = await analyzeVacancy(input);
      const questions = buildSmokePlan(analysis);
      const next: SmokeReviewSession = {
        id: uid(),
        vacancyAnalysisId: analysis.id,
        vacancyAnalysis: analysis,
        status: 'in_progress',
        questions,
        answers: [],
        currentIndex: 0,
        startedAt: Date.now(),
      };
      persist(next);
      setPhase('analysis');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось проанализировать вакансию.');
      setPhase('setup');
    }
  }, [persist]);

  const startInterview = useCallback(() => {
    if (!session?.questions.length) {
      setError('Не получилось собрать вопросы — вставьте более полную вакансию.');
      return;
    }
    setPhase('interview');
  }, [session]);

  const submitAnswer = useCallback(
    async (text: string, source: 'voice' | 'text', skipped = false) => {
      if (!session) return;
      const question = session.questions[session.currentIndex];
      if (!question) return;
      const others = session.answers.filter((a) => a.questionId !== question.id);
      if (skipped) {
        persist({
          ...session,
          answers: [
            ...others,
            { questionId: question.id, text: '', source, skipped: true, answeredAt: Date.now() },
          ],
        });
        return;
      }
      setEvaluating(true);
      try {
        const evaluation = await evaluateAnswer(question, text, session.vacancyAnalysis);
        persist({
          ...session,
          answers: [
            ...others,
            { questionId: question.id, text, source, skipped: false, evaluation, answeredAt: Date.now() },
          ],
        });
      } finally {
        setEvaluating(false);
      }
    },
    [session, persist],
  );

  const goNext = useCallback(() => {
    if (!session) return;
    const nextIndex = session.currentIndex + 1;
    if (nextIndex >= session.questions.length) {
      finish();
      return;
    }
    persist({ ...session, currentIndex: nextIndex });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, persist]);

  const finish = useCallback(() => {
    if (!session) return;
    const completed: SmokeReviewSession = {
      ...session,
      status: 'completed',
      completedAt: Date.now(),
    };
    completed.report = buildReadinessReport(completed);
    persist(completed);
    setPhase('report');
  }, [session, persist]);

  const restart = useCallback(() => {
    setSession(null);
    setError('');
    setPhase('setup');
  }, []);

  /** Start a fresh ≤4-question round focused on the weakest topics. */
  const startFollowUpRound = useCallback(() => {
    if (!session) return;
    const questions = buildFollowUpRound(session);
    if (!questions.length) return;
    const next: SmokeReviewSession = {
      id: uid(),
      vacancyAnalysisId: session.vacancyAnalysisId,
      vacancyAnalysis: session.vacancyAnalysis,
      status: 'in_progress',
      questions,
      answers: [],
      currentIndex: 0,
      startedAt: Date.now(),
    };
    persist(next);
    setPhase('interview');
  }, [session, persist]);

  return {
    phase,
    session,
    error,
    evaluating,
    analyze,
    startInterview,
    submitAnswer,
    goNext,
    finish,
    restart,
    startFollowUpRound,
    setPhase,
  };
}
