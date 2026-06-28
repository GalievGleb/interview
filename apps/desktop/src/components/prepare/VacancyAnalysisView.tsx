import type { TopicImportance, VacancyAnalysis } from '../../lib/vacancyReview/types';

interface Props {
  analysis: VacancyAnalysis;
  onStart: () => void;
  onBack: () => void;
  questionCount: number;
}

const SENIORITY_LABEL: Record<VacancyAnalysis['seniorityLevel'], string> = {
  intern: 'Intern',
  junior: 'Junior',
  middle: 'Middle',
  senior: 'Senior',
  lead: 'Lead',
  unknown: 'Not specified',
};

const IMPORTANCE_TONE: Record<TopicImportance, string> = {
  high: 'prep-tone-red',
  medium: 'prep-tone-blue',
  low: 'prep-tone-violet',
};

export default function VacancyAnalysisView({ analysis, onStart, onBack, questionCount }: Props) {
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="prep-eyebrow">Based on this vacancy</p>
          <h1 className="prep-h1 mt-1">{analysis.targetRole}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="prep-chip prep-tone-violet">{SENIORITY_LABEL[analysis.seniorityLevel]}</span>
            <span className="prep-chip">{analysis.interviewTopics.length} topics</span>
            <span className="prep-chip">Answers: {analysis.language.toUpperCase()}</span>
          </div>
        </div>
        <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onBack}>
          Edit vacancy
        </button>
      </div>

      {analysis.riskAreas.length > 0 && (
        <div className="prep-card prep-card-pad prep-topic prep-topic-amber">
          <p className="prep-h2 pl-2">Before you start</p>
          <ul className="mt-2 space-y-1.5 pl-2">
            {analysis.riskAreas.map((r) => (
              <li key={r} className="prep-sub flex gap-2">
                <span style={{ color: 'var(--prep-amber)' }}>•</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 className="prep-h2">Interview Readiness Map</h2>
        <p className="prep-faint mt-0.5">Topics extracted from the vacancy — this is what the mock will test.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {analysis.interviewTopics.map((t) => (
            <div key={t.id} className="prep-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="prep-faint">{t.category}</p>
                  <p className="prep-h2 truncate">{t.title}</p>
                </div>
                <span className={`prep-chip shrink-0 ${IMPORTANCE_TONE[t.importance]}`}>
                  {t.importance}
                </span>
              </div>
              <p className="prep-sub mt-2">{t.expectedKnowledge}</p>
              <p className="mt-2 text-[12px] italic" style={{ color: 'var(--prep-ink-faint)' }}>
                “{t.vacancyEvidence}”
              </p>
            </div>
          ))}
        </div>
      </div>

      {analysis.extractedRequirements.length > 0 && (
        <div className="prep-card prep-card-pad">
          <p className="prep-h2">Key requirements</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {analysis.extractedRequirements.map((r) => (
              <span key={r} className="prep-chip">
                {r}
              </span>
            ))}
            {analysis.optionalSkills.map((r) => (
              <span key={r} className="prep-chip prep-tone-violet">
                {r} · optional
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button type="button" className="prep-btn" onClick={onStart} disabled={questionCount === 0}>
          Start {questionCount}-question smoke interview
        </button>
        <span className="prep-faint">~20–30 min · grows in difficulty</span>
      </div>
    </div>
  );
}
