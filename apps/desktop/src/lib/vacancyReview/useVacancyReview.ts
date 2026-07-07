import { useCallback, useState } from 'react';
import {
  MAX_DRILL_DEPTH,
  analyzeVacancy,
  buildDrillDownQuestion,
  buildFollowUpRound,
  buildReadinessReport,
  buildSmokePlan,
  drillDepth,
  enrichReadinessReport,
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

  const startInterview = useCallback(
    (selectedTopicIds?: string[]) => {
      if (!session) return;
      const allTopics = session.vacancyAnalysis.interviewTopics;
      // Ученик отметил подмножество тем → пересобираем план только по ним.
      const useSubset =
        selectedTopicIds != null &&
        selectedTopicIds.length > 0 &&
        selectedTopicIds.length < allTopics.length;
      const nextQuestions = useSubset
        ? buildSmokePlan(session.vacancyAnalysis, selectedTopicIds)
        : session.questions;
      if (!nextQuestions.length) {
        setError('Не получилось собрать вопросы — выберите хотя бы одну тему или вставьте более полную вакансию.');
        return;
      }
      if (useSubset) {
        persist({ ...session, questions: nextQuestions, answers: [], currentIndex: 0 });
      }
      setPhase('interview');
    },
    [session, persist],
  );

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

  /**
   * Дожим: пользователь кликнул на уточняющий вопрос из оценки — вставляем его
   * следующим вопросом той же темы и сразу переходим к нему. Один дожим на
   * родительский вопрос и не глубже MAX_DRILL_DEPTH подряд — как живой
   * интервьюер: уточнил раз-два и отпустил тему.
   */
  const askFollowUp = useCallback(
    (followUpText: string) => {
      if (!session || !followUpText.trim()) return;
      const parent = session.questions[session.currentIndex];
      if (!parent) return;
      if (session.questions.some((q) => q.parentQuestionId === parent.id)) return;
      if (drillDepth(parent, session.questions) >= MAX_DRILL_DEPTH) return;
      const evaluation = session.answers.find((a) => a.questionId === parent.id)?.evaluation;
      const drill = buildDrillDownQuestion(parent, followUpText.trim(), evaluation);
      const questions = [...session.questions];
      questions.splice(session.currentIndex + 1, 0, drill);
      persist({ ...session, questions, currentIndex: session.currentIndex + 1 });
    },
    [session, persist],
  );

  const finish = useCallback(() => {
    if (!session) return;
    const completed: SmokeReviewSession = {
      ...session,
      status: 'completed',
      completedAt: Date.now(),
    };
    const report = buildReadinessReport(completed);
    completed.report = report;
    persist(completed);
    setPhase('report');
    // Детерминированный отчёт уже на экране; LLM-вердикт коуча подтягивается
    // асинхронно. Состояние обновляем только если пользователь ещё в этой сессии.
    void enrichReadinessReport(completed, report).then((enriched) => {
      if (enriched === report) return;
      const next = { ...completed, report: enriched };
      saveSession(next);
      setSession((cur) => (cur && cur.id === completed.id ? next : cur));
    });
  }, [session, persist]);

  const restart = useCallback(() => {
    setSession(null);
    setError('');
    setPhase('setup');
  }, []);

  /**
   * Start a fresh ≤4-question round — on the weakest topics, or on one
   * specific topic (topicId) when the user picks "Повторить тему".
   */
  const startFollowUpRound = useCallback((topicId?: string) => {
    if (!session) return;
    const questions = buildFollowUpRound(session, topicId);
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
    askFollowUp,
    finish,
    restart,
    startFollowUpRound,
    setPhase,
  };
}
