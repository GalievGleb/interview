import ReadinessRing from './ReadinessRing';
import TopicCard from './TopicCard';
import { readinessLabelText, readinessTone } from '../../lib/vacancyReview/readiness';
import type { ReadinessReport, VacancyAnalysis } from '../../lib/vacancyReview/types';

interface Props {
  report: ReadinessReport;
  analysis: VacancyAnalysis;
  onSave: () => void;
  onStartLive: () => void;
  onNewReview: () => void;
  onFollowUpRound?: () => void;
}

export default function ReadinessReportView({
  report,
  analysis,
  onSave,
  onStartLive,
  onNewReview,
  onFollowUpRound,
}: Props) {
  const tone = readinessTone(report.status);
  const hasWeak = report.weakAreas.length > 0 || report.criticalGaps.length > 0;
  return (
    <div className="prep-rise space-y-5">
      <div className="prep-card prep-card-pad">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
          <ReadinessRing score={report.overallScore} label={readinessLabelText(report.status)} tone={tone} />
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <p className="prep-eyebrow">Ready for this vacancy</p>
            <h1 className="prep-h1 mt-1">{analysis.targetRole}</h1>
            <p className="prep-sub mt-1.5">
              {report.overallScore >= 70
                ? 'You’re in good shape for this vacancy — tighten the few weak spots below.'
                : report.overallScore >= 50
                  ? 'Almost there — a couple of topics need stronger, more concrete answers.'
                  : 'Some core topics aren’t ready yet. Focus your practice on the critical gaps first.'}
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
              {onFollowUpRound && hasWeak && (
                <button type="button" className="prep-btn prep-btn-sm" onClick={onFollowUpRound}>
                  Ещё раунд по слабым темам (4 вопроса)
                </button>
              )}
              <button
                type="button"
                className={`prep-btn-sm ${onFollowUpRound && hasWeak ? 'prep-btn-secondary' : 'prep-btn'}`}
                onClick={onStartLive}
              >
                Start live interview with this context
              </button>
              <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onSave}>
                Save report
              </button>
              <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onNewReview}>
                New vacancy
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard tone="green" title="Strengths" items={report.strengths} empty="None strong yet" />
        <SummaryCard tone="amber" title="Weak areas" items={report.weakAreas} empty="No weak areas" />
        <SummaryCard tone="red" title="Critical gaps" items={report.criticalGaps} empty="No critical gaps 🎉" />
      </div>

      <div>
        <h2 className="prep-h2">Interview Readiness Map</h2>
        <p className="prep-faint mt-0.5">Per-topic readiness from your answers.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {report.topicScores.map((t) => (
            <TopicCard key={t.topicId} topic={t} />
          ))}
        </div>
      </div>

      {report.nextPracticePlan.length > 0 && (
        <div className="prep-card prep-card-pad prep-topic prep-topic-green">
          <p className="prep-h2 pl-2">Recommended next practice</p>
          <ol className="mt-2 space-y-1.5 pl-2">
            {report.nextPracticePlan.map((step, i) => (
              <li key={step} className="prep-sub flex gap-2">
                <span className="font-semibold" style={{ color: 'var(--prep-green)' }}>
                  {i + 1}.
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  tone,
  title,
  items,
  empty,
}: {
  tone: 'green' | 'amber' | 'red';
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <div className={`prep-card p-4 prep-topic prep-topic-${tone}`}>
      <p className="prep-h2 pl-2">{title}</p>
      {items.length ? (
        <ul className="mt-2 space-y-1 pl-2">
          {items.map((i) => (
            <li key={i} className="text-[13px]" style={{ color: 'var(--prep-ink-muted)' }}>
              {i}
            </li>
          ))}
        </ul>
      ) : (
        <p className="prep-faint mt-2 pl-2">{empty}</p>
      )}
    </div>
  );
}
