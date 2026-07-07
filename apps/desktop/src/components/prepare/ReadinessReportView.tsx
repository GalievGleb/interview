import ReadinessRing from './ReadinessRing';
import TopicCard from './TopicCard';
import { readinessLabelText, readinessTone } from '../../lib/vacancyReview/readiness';
import { useI18n } from '../../lib/i18n';
import type { ReadinessReport, VacancyAnalysis } from '../../lib/vacancyReview/types';

interface Props {
  report: ReadinessReport;
  analysis: VacancyAnalysis;
  onSave: () => void;
  onPrint?: () => void;
  onStartLive: () => void;
  onNewReview: () => void;
  onFollowUpRound?: () => void;
  onPracticeTopic?: (topicId: string) => void;
  /** Скоры прошлых раундов по этой же вакансии (старые → новые), включая текущий. */
  scoreHistory?: number[];
}

export default function ReadinessReportView({
  report,
  analysis,
  onSave,
  onPrint,
  onStartLive,
  onNewReview,
  onFollowUpRound,
  onPracticeTopic,
  scoreHistory,
}: Props) {
  const { t } = useI18n();
  const tone = readinessTone(report.status);
  const hasWeak = report.weakAreas.length > 0 || report.criticalGaps.length > 0;
  return (
    <div className="prep-rise space-y-5">
      <div className="prep-card prep-card-pad">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
          <ReadinessRing score={report.overallScore} label={readinessLabelText(report.status)} tone={tone} />
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <p className="prep-eyebrow">{t('prep.report.eyebrow')}</p>
            <h1 className="prep-h1 mt-1">{analysis.targetRole}</h1>
            <p className="prep-sub mt-1.5">
              {report.overallScore >= 70
                ? t('prep.report.verdictHigh')
                : report.overallScore >= 50
                  ? t('prep.report.verdictMid')
                  : t('prep.report.verdictLow')}
            </p>
            {scoreHistory && scoreHistory.length >= 2 && (
              <p className="prep-faint mt-1.5" title={t('prep.report.progressTitle')}>
                {t('prep.report.progress')}{' '}
                {scoreHistory.map((s, i) => (
                  <span key={`${i}-${s}`}>
                    {i > 0 && ' → '}
                    <span
                      style={
                        i === scoreHistory.length - 1
                          ? { color: 'var(--prep-green)', fontWeight: 700 }
                          : undefined
                      }
                    >
                      {s}
                    </span>
                  </span>
                ))}
                {scoreHistory[scoreHistory.length - 1] > scoreHistory[0] && ' 📈'}
              </p>
            )}
            <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
              {onFollowUpRound && hasWeak && (
                <button type="button" className="prep-btn prep-btn-sm" onClick={onFollowUpRound}>
                  {t('prep.report.anotherRound')}
                </button>
              )}
              <button
                type="button"
                className={`prep-btn-sm ${onFollowUpRound && hasWeak ? 'prep-btn-secondary' : 'prep-btn'}`}
                onClick={onStartLive}
              >
                {t('prep.report.startLive')}
              </button>
              {onPrint && (
                <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onPrint}>
                  {t('prep.report.print')}
                </button>
              )}
              <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onSave}>
                {t('prep.report.save')}
              </button>
              <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onNewReview}>
                {t('prep.report.newVacancy')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {analysis.analysisSource === 'heuristic' && (
        <div className="prep-card prep-card-pad prep-topic prep-topic-amber">
          <p className="prep-sub pl-2">
            <strong>{t('prep.report.noAiTitle')}</strong>
            {t('prep.report.noAiBody')}
          </p>
        </div>
      )}

      {report.narrativeVerdict && (
        <div className="prep-card prep-card-pad">
          <p className="prep-eyebrow">{t('prep.report.coachVerdict')}</p>
          <p className="prep-sub mt-1.5">{report.narrativeVerdict}</p>
          {report.interviewerImpression && (
            <p className="prep-faint mt-2">
              {t('prep.report.impression')} {report.interviewerImpression}
            </p>
          )}
          {report.focusTopic && (
            <p className="prep-faint mt-1">
              {t('prep.report.startWith')} <span className="font-semibold">{report.focusTopic}</span>
            </p>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard tone="green" title={t('history.mock.strengths')} items={report.strengths} empty={t('prep.report.strengthsEmpty')} />
        <SummaryCard tone="amber" title={t('history.mock.weakAreas')} items={report.weakAreas} empty={t('prep.report.weakEmpty')} />
        <SummaryCard
          tone="red"
          title={t('history.mock.criticalGaps')}
          items={report.criticalGaps}
          empty={report.overallScore >= 50 ? t('prep.report.gapsEmptyWin') : t('prep.report.gapsEmpty')}
        />
      </div>

      <div>
        <h2 className="prep-h2">{t('prep.analysis.readinessMap')}</h2>
        <p className="prep-faint mt-0.5">{t('prep.report.readinessByAnswers')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {report.topicScores.map((topic) => (
            <TopicCard key={topic.topicId} topic={topic} onPractice={onPracticeTopic} />
          ))}
        </div>
      </div>

      {report.nextPracticePlan.length > 0 && (
        <div className="prep-card prep-card-pad prep-topic prep-topic-green">
          <p className="prep-h2 pl-2">{t('prep.report.recommendations')}</p>
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
