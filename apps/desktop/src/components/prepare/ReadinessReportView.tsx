import { useMemo } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Download,
  Mic2,
  MoreHorizontal,
  Printer,
  RotateCcw,
  Send,
  TrendingUp,
} from 'lucide-react';
import ReadinessRing from './ReadinessRing';
import TopicCard from './TopicCard';
import {
  readinessLabelText,
  readinessTone,
  topicStatusText,
  topicStatusTone,
} from '../../lib/vacancyReview/readiness';
import { useI18n } from '../../lib/i18n';
import type {
  ReadinessReport,
  TopicScore,
  VacancyAnalysis,
} from '../../lib/vacancyReview/types';

interface Props {
  report: ReadinessReport;
  analysis: VacancyAnalysis;
  onSave: () => void;
  onPrint?: () => void;
  onStartLive: () => void;
  onNewReview: () => void;
  onFollowUpRound?: () => void;
  onPracticeTopic?: (topicId: string) => void;
  onApply?: () => void;
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
  onApply,
  scoreHistory,
}: Props) {
  const { t } = useI18n();
  const tone = readinessTone(report.status);
  const hasWeak = report.weakAreas.length > 0 || report.criticalGaps.length > 0;
  const priorityTopics = useMemo(
    () => [...report.topicScores].sort((a, b) => a.score - b.score).slice(0, 3),
    [report.topicScores],
  );

  return (
    <div className="prep-rise space-y-5">
      <section className="prep-report-hero">
        <ReadinessRing
          score={report.overallScore}
          label={readinessLabelText(report.status)}
          tone={tone}
          size={128}
        />
        <div className="min-w-0">
          <p className="prep-eyebrow">{t('prep.report.eyebrow')}</p>
          <h1 className="prep-h1 mt-1">{analysis.targetRole}</h1>
          <p className="prep-sub mt-2">
            {report.overallScore >= 70
              ? t('prep.report.verdictHigh')
              : report.overallScore >= 50
                ? t('prep.report.verdictMid')
                : t('prep.report.verdictLow')}
          </p>

          {scoreHistory && scoreHistory.length >= 2 && (
            <div className="prep-report-progress" title={t('prep.report.progressTitle')}>
              <TrendingUp size={14} aria-hidden="true" />
              <span>{t('prep.report.progress')}</span>
              <strong>{scoreHistory.join(' → ')}</strong>
            </div>
          )}

          <div className="prep-report-actions">
            {onFollowUpRound && hasWeak ? (
              <>
                <button type="button" className="prep-btn" onClick={onFollowUpRound}>
                  <RotateCcw size={15} aria-hidden="true" />
                  {t('prep.report.anotherRound')}
                </button>
                <button type="button" className="prep-btn-secondary" onClick={onStartLive}>
                  <Mic2 size={15} aria-hidden="true" />
                  {t('prep.report.startLive')}
                </button>
              </>
            ) : (
              <button type="button" className="prep-btn" onClick={onStartLive}>
                <Mic2 size={15} aria-hidden="true" />
                {t('prep.report.startLive')}
              </button>
            )}

            <details className="prep-action-menu">
              <summary aria-label={t('prep.report.moreActions')}>
                <MoreHorizontal size={17} aria-hidden="true" />
              </summary>
              <div>
                {onPrint && (
                  <button type="button" onClick={onPrint}>
                    <Printer size={14} aria-hidden="true" />
                    {t('prep.report.print')}
                  </button>
                )}
                <button type="button" onClick={onSave}>
                  <Download size={14} aria-hidden="true" />
                  {t('prep.report.save')}
                </button>
                <button type="button" onClick={onNewReview}>
                  <RotateCcw size={14} aria-hidden="true" />
                  {t('prep.report.newVacancy')}
                </button>
              </div>
            </details>
          </div>
        </div>

        <div className="prep-report-summary">
          <SummaryStat
            tone="green"
            value={report.strengths.length}
            label={t('history.mock.strengths')}
          />
          <SummaryStat
            tone="amber"
            value={report.weakAreas.length}
            label={t('history.mock.weakAreas')}
          />
          <SummaryStat
            tone="red"
            value={report.criticalGaps.length}
            label={t('history.mock.criticalGaps')}
          />
        </div>
      </section>

      {analysis.analysisSource === 'heuristic' && (
        <div className="prep-analysis-warning" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>{t('prep.report.noAiTitle')}</strong>
            <p>{t('prep.report.noAiBody')}</p>
          </div>
        </div>
      )}

      {onApply && (
        <section className="prep-apply-handoff" aria-labelledby="prep-apply-title">
          <div>
            <p className="prep-eyebrow">Следующий шаг</p>
            <h2 id="prep-apply-title">Проверьте отклик по этой вакансии</h2>
            <p>
              Вакансия и выбранное резюме будут перенесены в HH. Ничего не отправится,
              пока вы явно не подтвердите отклик.
            </p>
          </div>
          <button type="button" className="prep-btn" onClick={onApply}>
            <Send size={15} aria-hidden="true" />
            Перейти к проверке отклика
          </button>
        </section>
      )}

      {(report.narrativeVerdict || report.interviewerImpression || report.focusTopic) && (
        <section className="prep-coach-note">
          <p className="prep-eyebrow">{t('prep.report.coachVerdict')}</p>
          {report.narrativeVerdict && <p>{report.narrativeVerdict}</p>}
          <div>
            {report.interviewerImpression && (
              <span>
                <strong>{t('prep.report.impression')}</strong> {report.interviewerImpression}
              </span>
            )}
            {report.focusTopic && (
              <span>
                <strong>{t('prep.report.startWith')}</strong> {report.focusTopic}
              </span>
            )}
          </div>
        </section>
      )}

      <section>
        <div className="prep-report-section-heading">
          <div>
            <p className="prep-eyebrow">{t('prep.report.priorityEyebrow')}</p>
            <h2 className="prep-h2 mt-1">{t('prep.report.priorityTitle')}</h2>
          </div>
          <p className="prep-faint">{t('prep.report.readinessByAnswers')}</p>
        </div>
        <div className="prep-report-priorities">
          {priorityTopics.map((topic) => (
            <PriorityTopic key={topic.topicId} topic={topic} onPractice={onPracticeTopic} />
          ))}
        </div>
      </section>

      {report.nextPracticePlan.length > 0 && (
        <section className="prep-next-plan">
          <div>
            <p className="prep-eyebrow">{t('prep.report.recommendations')}</p>
            <h2>{report.nextPracticePlan[0]}</h2>
          </div>
          {report.nextPracticePlan.length > 1 && (
            <ol>
              {report.nextPracticePlan.slice(1, 4).map((step, index) => (
                <li key={step}>
                  <span>{index + 2}</span>
                  {step}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <details className="prep-full-report">
        <summary>
          <span>{t('prep.report.fullMap')}</span>
          <span>
            {report.topicScores.length}
            <ChevronDown size={15} aria-hidden="true" />
          </span>
        </summary>
        <div className="prep-full-report__body">
          <div className="grid gap-3 sm:grid-cols-2">
            {report.topicScores.map((topic) => (
              <TopicCard key={topic.topicId} topic={topic} onPractice={onPracticeTopic} />
            ))}
          </div>
          <div className="prep-report-lists">
            <SummaryList
              tone="green"
              title={t('history.mock.strengths')}
              items={report.strengths}
              empty={t('prep.report.strengthsEmpty')}
            />
            <SummaryList
              tone="amber"
              title={t('history.mock.weakAreas')}
              items={report.weakAreas}
              empty={t('prep.report.weakEmpty')}
            />
            <SummaryList
              tone="red"
              title={t('history.mock.criticalGaps')}
              items={report.criticalGaps}
              empty={
                report.overallScore >= 50
                  ? t('prep.report.gapsEmptyWin')
                  : t('prep.report.gapsEmpty')
              }
            />
          </div>
        </div>
      </details>
    </div>
  );
}

function PriorityTopic({
  topic,
  onPractice,
}: {
  topic: TopicScore;
  onPractice?: (topicId: string) => void;
}) {
  const { t } = useI18n();
  const tone = topicStatusTone(topic.status);
  return (
    <div className={`prep-report-priority prep-topic-${tone}`}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="prep-faint">{topic.category}</p>
          <h3 className="truncate">{topic.title}</h3>
        </div>
        <span className={`prep-chip prep-tone-${tone}`}>
          {topicStatusText(topic.status)}
        </span>
      </div>
      <div className="prep-report-priority__score">
        <strong style={{ color: `var(--prep-${tone})` }}>{topic.score}%</strong>
        <div className={`prep-bar prep-bar-${tone}`}>
          <span style={{ width: `${topic.score}%` }} />
        </div>
      </div>
      <p>{topic.feedback}</p>
      {onPractice && (
        <button
          type="button"
          className="prep-link-btn"
          onClick={() => onPractice(topic.topicId)}
        >
          {t('prep.practiceTopic')}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function SummaryStat({
  tone,
  value,
  label,
}: {
  tone: 'green' | 'amber' | 'red';
  value: number;
  label: string;
}) {
  return (
    <div className={`prep-report-stat prep-topic-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SummaryList({
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
      {items.length > 0 ? (
        <ul className="mt-2 space-y-1 pl-2">
          {items.map((item) => (
            <li key={item} className="prep-sub">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="prep-faint mt-2 pl-2">{empty}</p>
      )}
    </div>
  );
}
