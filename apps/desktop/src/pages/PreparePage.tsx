import { useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import CandidateJourneyStrip from '../components/candidate/CandidateJourneyStrip';
import VacancySetup from '../components/prepare/VacancySetup';
import VacancyAnalysisView from '../components/prepare/VacancyAnalysisView';
import SmokeInterviewView from '../components/prepare/SmokeInterviewView';
import ReadinessReportView from '../components/prepare/ReadinessReportView';
import { printReadinessReport } from '../lib/vacancyReview/reportPrint';
import { useVacancyReview } from '../lib/vacancyReview/useVacancyReview';
import { getSession, listSessions } from '../lib/vacancyReview/vacancyReviewStore';
import { launchLive } from '../lib/launchLive';
import type { CandidateJourneyStep } from '../lib/candidateJourney';

export default function PreparePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const resumeId = params.get('session');
  const focusTopic = params.get('focusTopic');
  const initialVacancyUrl = params.get('vacancyUrl') ?? '';
  const initialResumeTitle = params.get('resumeTitle') ?? '';
  const initial = useMemo(() => (resumeId ? getSession(resumeId) : null), [resumeId]);

  const review = useVacancyReview(initial);
  const { phase, session } = review;
  const journeySteps = useMemo<CandidateJourneyStep[]>(() => {
    const analysisReady = phase === 'analysis' || phase === 'interview' || phase === 'report';
    const practiceDone = phase === 'report';
    const current = phase === 'setup'
      ? 'vacancy'
      : phase === 'analyzing'
        ? 'match'
        : phase === 'report'
          ? 'apply'
          : 'practice';
    const done = {
      vacancy: phase !== 'setup',
      resume: Boolean(session?.vacancyAnalysis.hasResume),
      match: analysisReady,
      practice: practiceDone,
      apply: false,
      response: false,
    };
    const step = (id: keyof typeof done, label: string, description: string): CandidateJourneyStep => ({
      id,
      label,
      description,
      status: done[id] ? 'done' : current === id ? 'current' : 'upcoming',
    });
    return [
      step('vacancy', 'Вакансия', 'Требования роли'),
      step('resume', 'Резюме', 'Ваш опыт'),
      step('match', 'Сопоставление', 'Разрывы и сильные стороны'),
      step('practice', 'Практика', 'Вопросы по разрывам'),
      step('apply', 'Отклик', 'Проверка перед отправкой'),
      step('response', 'Ответ HR', 'После отклика'),
    ];
  }, [phase, session?.vacancyAnalysis.hasResume]);

  // Deep link from HomePage's "Повторить тему": jump straight into practicing
  // that one topic instead of showing the report first.
  const startedFocusTopic = useRef(false);
  useEffect(() => {
    if (!focusTopic || startedFocusTopic.current) return;
    if (phase !== 'report' || !session?.report) return;
    startedFocusTopic.current = true;
    review.startFollowUpRound(focusTopic);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTopic, phase, session]);

  const downloadReport = () => {
    if (!session?.report) return;
    const blob = new Blob([JSON.stringify({ analysis: session.vacancyAnalysis, report: session.report }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vacancy-readiness-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap">
        <CandidateJourneyStrip
          compact
          steps={journeySteps}
          ariaLabel="Путь подготовки по вакансии"
        />

        {(phase === 'setup' || phase === 'analyzing') && (
          <VacancySetup
            onAnalyze={review.analyze}
            analyzing={phase === 'analyzing'}
            error={review.error}
            initialVacancyUrl={initialVacancyUrl}
            initialResumeTitle={initialResumeTitle}
          />
        )}

        {phase === 'analysis' && session && (
          <VacancyAnalysisView
            analysis={session.vacancyAnalysis}
            questionCount={session.questions.length}
            onStart={review.startInterview}
            onBack={review.restart}
            onRetry={() => {
              void review.analyze({
                vacancyText: session.vacancyAnalysis.vacancyText,
                vacancyUrl: session.vacancyAnalysis.vacancyUrl,
                vacancyCompany: session.vacancyAnalysis.vacancyCompany,
                targetRole: session.vacancyAnalysis.targetRole,
                language: session.vacancyAnalysis.language,
                resumeText: session.vacancyAnalysis.resumeText,
                legendText: session.vacancyAnalysis.legendText,
              });
            }}
          />
        )}

        {phase === 'interview' && session && (
          <SmokeInterviewView
            session={session}
            evaluating={review.evaluating}
            onSubmitAnswer={review.submitAnswer}
            onNext={review.goNext}
            onFinish={review.finish}
            onAskFollowUp={review.askFollowUp}
          />
        )}

        {phase === 'report' && session?.report && (
          <ReadinessReportView
            report={session.report}
            analysis={session.vacancyAnalysis}
            onSave={downloadReport}
            onPrint={() => printReadinessReport(session.vacancyAnalysis, session.report!)}
            onStartLive={() => launchLive(() => navigate('/overlay'))}
            onNewReview={review.restart}
            onFollowUpRound={() => review.startFollowUpRound()}
            onPracticeTopic={review.startFollowUpRound}
            onApply={session.vacancyAnalysis.vacancyUrl ? () => {
              const query = new URLSearchParams({
                vacancyUrl: session.vacancyAnalysis.vacancyUrl!,
                session: session.id,
              });
              if (session.vacancyAnalysis.resumeSource?.title) {
                query.set('resumeTitle', session.vacancyAnalysis.resumeSource.title);
              }
              navigate(`/applications?${query.toString()}`);
            } : undefined}
            scoreHistory={listSessions()
              .filter((s) => s.vacancyAnalysisId === session.vacancyAnalysisId && s.report)
              .sort((a, b) => a.startedAt - b.startedAt)
              .map((s) => s.report!.overallScore)}
          />
        )}
      </div>
    </div>
  );
}
