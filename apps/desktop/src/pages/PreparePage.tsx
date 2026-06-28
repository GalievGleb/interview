import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import VacancySetup from '../components/prepare/VacancySetup';
import VacancyAnalysisView from '../components/prepare/VacancyAnalysisView';
import SmokeInterviewView from '../components/prepare/SmokeInterviewView';
import ReadinessReportView from '../components/prepare/ReadinessReportView';
import { useVacancyReview } from '../lib/vacancyReview/useVacancyReview';
import { getSession } from '../lib/vacancyReview/vacancyReviewStore';

export default function PreparePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const resumeId = params.get('session');
  const initial = useMemo(() => (resumeId ? getSession(resumeId) : null), [resumeId]);

  const review = useVacancyReview(initial);
  const { phase, session } = review;

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
            onSubmitAnswer={review.submitAnswer}
            onNext={review.goNext}
            onFinish={review.finish}
          />
        )}

        {phase === 'report' && session?.report && (
          <ReadinessReportView
            report={session.report}
            analysis={session.vacancyAnalysis}
            onSave={downloadReport}
            onStartLive={() => navigate('/interview')}
            onNewReview={review.restart}
          />
        )}
      </div>
    </div>
  );
}
