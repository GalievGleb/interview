import ReadinessRing from './ReadinessRing';
import TopicCard from './TopicCard';
import { readinessLabelText, readinessTone } from '../../lib/vacancyReview/readiness';
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
  const tone = readinessTone(report.status);
  const hasWeak = report.weakAreas.length > 0 || report.criticalGaps.length > 0;
  return (
    <div className="prep-rise space-y-5">
      <div className="prep-card prep-card-pad">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
          <ReadinessRing score={report.overallScore} label={readinessLabelText(report.status)} tone={tone} />
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <p className="prep-eyebrow">Готовность к вакансии</p>
            <h1 className="prep-h1 mt-1">{analysis.targetRole}</h1>
            <p className="prep-sub mt-1.5">
              {report.overallScore >= 70
                ? 'Вы в хорошей форме для этой вакансии — подтяните пару слабых мест ниже.'
                : report.overallScore >= 50
                  ? 'Почти готовы — паре тем не хватает более конкретных ответов.'
                  : 'Часть ключевых тем пока не готова. Начните тренировку с критичных пробелов.'}
            </p>
            {scoreHistory && scoreHistory.length >= 2 && (
              <p className="prep-faint mt-1.5" title="Общий балл по раундам этой вакансии">
                Прогресс по этой вакансии:{' '}
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
                  Ещё раунд по слабым темам (4 вопроса)
                </button>
              )}
              <button
                type="button"
                className={`prep-btn-sm ${onFollowUpRound && hasWeak ? 'prep-btn-secondary' : 'prep-btn'}`}
                onClick={onStartLive}
              >
                Начать live-интервью с этим контекстом
              </button>
              {onPrint && (
                <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onPrint}>
                  Распечатать / PDF
                </button>
              )}
              <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onSave}>
                Сохранить отчёт
              </button>
              <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onNewReview}>
                Новая вакансия
              </button>
            </div>
          </div>
        </div>
      </div>

      {analysis.analysisSource === 'heuristic' && (
        <div className="prep-card prep-card-pad prep-topic prep-topic-amber">
          <p className="prep-sub pl-2">
            <strong>Отчёт собран без AI</strong> — разбор и оценки посчитаны локальным алгоритмом,
            проценты ориентировочные. Подключите AI-ключ в настройках и пройдите раунд ещё раз,
            чтобы получить честную оценку готовности.
          </p>
        </div>
      )}

      {report.narrativeVerdict && (
        <div className="prep-card prep-card-pad">
          <p className="prep-eyebrow">Вердикт коуча</p>
          <p className="prep-sub mt-1.5">{report.narrativeVerdict}</p>
          {report.interviewerImpression && (
            <p className="prep-faint mt-2">
              Как вас видит интервьюер: {report.interviewerImpression}
            </p>
          )}
          {report.focusTopic && (
            <p className="prep-faint mt-1">
              Начать стоит с темы: <span className="font-semibold">{report.focusTopic}</span>
            </p>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard tone="green" title="Сильные стороны" items={report.strengths} empty="Пока нет уверенных тем" />
        <SummaryCard tone="amber" title="Слабые места" items={report.weakAreas} empty="Слабых мест нет" />
        <SummaryCard
          tone="red"
          title="Критичные пробелы"
          items={report.criticalGaps}
          empty={report.overallScore >= 50 ? 'Критичных пробелов нет 🎉' : 'Критичных пробелов нет'}
        />
      </div>

      <div>
        <h2 className="prep-h2">Карта готовности к интервью</h2>
        <p className="prep-faint mt-0.5">Готовность по темам на основе ваших ответов.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {report.topicScores.map((t) => (
            <TopicCard key={t.topicId} topic={t} onPractice={onPracticeTopic} />
          ))}
        </div>
      </div>

      {report.nextPracticePlan.length > 0 && (
        <div className="prep-card prep-card-pad prep-topic prep-topic-green">
          <p className="prep-h2 pl-2">Рекомендации по подготовке</p>
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
