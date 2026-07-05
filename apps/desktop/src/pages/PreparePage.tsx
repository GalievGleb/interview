import { useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import VacancySetup from '../components/prepare/VacancySetup';
import VacancyAnalysisView from '../components/prepare/VacancyAnalysisView';
import SmokeInterviewView from '../components/prepare/SmokeInterviewView';
import ReadinessReportView from '../components/prepare/ReadinessReportView';
import { printReadinessReport } from '../lib/vacancyReview/reportPrint';
import { useVacancyReview } from '../lib/vacancyReview/useVacancyReview';
import { getSession, listSessions } from '../lib/vacancyReview/vacancyReviewStore';

export default function PreparePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const resumeId = params.get('session');
  const focusTopic = params.get('focusTopic');
  const initial = useMemo(() => (resumeId ? getSession(resumeId) : null), [resumeId]);

  const review = useVacancyReview(initial);
  const { phase, session } = review;

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
        {(phase === 'setup' || phase === 'analyzing') && (
          <VacancySetup onAnalyze={review.analyze} analyzing={phase === 'analyzing'} error={review.error} />
        )}

        {phase === 'analysis' && session && (
          <VacancyAnalysisView
            analysis={session.vacancyAnalysis}
            questionCount={session.questions.length}
            onStart={review.startInterview}
            onBack={review.restart}
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
            onStartLive={() => navigate('/interview')}
            onNewReview={review.restart}
            onFollowUpRound={() => review.startFollowUpRound()}
            onPracticeTopic={review.startFollowUpRound}
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
