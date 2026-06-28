import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import ReadinessRing from '../components/prepare/ReadinessRing';
import { readinessLabelText, readinessTone, topicStatusTone } from '../lib/vacancyReview/readiness';
import { latestCompleted, latestInProgress, listSessions } from '../lib/vacancyReview/vacancyReviewStore';

export default function HomePage() {
  const navigate = useNavigate();
  const sessions = useMemo(() => listSessions(), []);
  const inProgress = useMemo(() => latestInProgress(), []);
  const completed = useMemo(() => latestCompleted(), []);
  const report = completed?.report;

  const weakest = report
    ? [...report.topicScores].sort((a, b) => a.score - b.score).slice(0, 3)
    : [];

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="prep-eyebrow">Interview prep</p>
            <h1 className="prep-h1 mt-1">Ready for your next interview?</h1>
            <p className="prep-sub mt-1.5 max-w-xl">
              Paste a vacancy → get the likely interview topics → run a quick mock → see where you’re
              not ready yet.
            </p>
          </div>
          <button type="button" className="prep-btn" onClick={() => navigate('/prepare')}>
            + Start smoke review
          </button>
        </div>

        {/* Top row: vacancy readiness + continue/CTA */}
        <div className="mt-5 grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="prep-card prep-card-pad">
            {report ? (
              <div className="flex items-center gap-5">
                <ReadinessRing
                  score={report.overallScore}
                  label={readinessLabelText(report.status)}
                  tone={readinessTone(report.status)}
                  size={112}
                />
                <div className="min-w-0">
                  <p className="prep-faint">Vacancy readiness</p>
                  <p className="prep-h2 truncate">{completed?.vacancyAnalysis.targetRole}</p>
                  <p className="prep-sub mt-1">
                    {report.topicScores.length} topics · {report.strengths.length} strong ·{' '}
                    {report.criticalGaps.length} critical
                  </p>
                  <button
                    type="button"
                    className="prep-btn-ghost prep-btn-sm mt-3"
                    onClick={() => navigate(`/prepare?session=${completed!.id}`)}
                  >
                    View report
                  </button>
                </div>
              </div>
            ) : (
              <EmptyReadiness onStart={() => navigate('/prepare')} />
            )}
          </div>

          <div className="prep-card prep-card-pad flex flex-col">
            <p className="prep-faint">Continue smoke review</p>
            {inProgress ? (
              <>
                <p className="prep-h2 mt-1 truncate">{inProgress.vacancyAnalysis.targetRole}</p>
                <p className="prep-sub mt-1">
                  {inProgress.answers.length} / {inProgress.questions.length} answered
                </p>
                <div className="prep-bar prep-bar-green mt-2">
                  <span
                    style={{
                      width: `${Math.round((inProgress.answers.length / inProgress.questions.length) * 100)}%`,
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="prep-btn prep-btn-sm mt-auto self-start"
                  onClick={() => navigate(`/prepare?session=${inProgress.id}`)}
                >
                  Continue
                </button>
              </>
            ) : (
              <>
                <p className="prep-sub mt-1">No review in progress.</p>
                <button
                  type="button"
                  className="prep-btn prep-btn-sm mt-auto self-start"
                  onClick={() => navigate('/prepare')}
                >
                  Add vacancy
                </button>
              </>
            )}
          </div>
        </div>

        {/* Weakest topics */}
        {weakest.length > 0 && (
          <div className="mt-4">
            <h2 className="prep-h2">Weakest topics</h2>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              {weakest.map((t) => {
                const tone = topicStatusTone(t.status);
                return (
                  <div key={t.topicId} className={`prep-card p-4 prep-topic prep-topic-${tone}`}>
                    <p className="prep-h2 pl-2 truncate">{t.title}</p>
                    <p className="pl-2 text-[20px] font-bold" style={{ color: 'var(--prep-ink)' }}>
                      {t.score}%
                    </p>
                    <button
                      type="button"
                      className="prep-btn-ghost prep-btn-sm ml-2 mt-2"
                      onClick={() => navigate('/prepare')}
                    >
                      Practice this topic
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recent sessions */}
        {sessions.length > 0 && (
          <div className="mt-4">
            <h2 className="prep-h2">Recent mock sessions</h2>
            <div className="prep-card mt-2 divide-y" style={{ borderColor: 'var(--prep-border)' }}>
              {sessions.slice(0, 6).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => navigate(`/prepare?session=${s.id}`)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  style={{ borderColor: 'var(--prep-border)' }}
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium" style={{ color: 'var(--prep-ink)' }}>
                      {s.vacancyAnalysis.targetRole}
                    </p>
                    <p className="prep-faint">
                      {new Date(s.startedAt).toLocaleDateString()} ·{' '}
                      {s.status === 'completed' ? 'completed' : 'in progress'}
                    </p>
                  </div>
                  <span className="prep-chip shrink-0">
                    {s.report ? `${s.report.overallScore}%` : `${s.answers.length}/${s.questions.length}`}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyReadiness({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="prep-h2">No vacancy reviewed yet</p>
      <p className="prep-sub max-w-md">
        Add a real vacancy and SkillCue will extract the likely interview topics and run a quick mock
        to show your readiness — strong, weak, or not ready yet.
      </p>
      <button type="button" className="prep-btn prep-btn-sm mt-2" onClick={onStart}>
        Analyze a vacancy
      </button>
    </div>
  );
}
