import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { pluralRu } from '../../lib/pluralRu';
import { useI18n, type I18nKey } from '../../lib/i18n';
import { buildSmokePlan } from '../../lib/vacancyReview/vacancyReviewService';
import type {
  Competency,
  ResumeMatch,
  TopicImportance,
  VacancyAnalysis,
} from '../../lib/vacancyReview/types';

interface Props {
  analysis: VacancyAnalysis;
  /** Запуск mock по отмеченным темам (по умолчанию — все). */
  onStart: (topicIds: string[]) => void;
  onBack: () => void;
  questionCount: number;
}

const SENIORITY_KEY: Record<VacancyAnalysis['seniorityLevel'], I18nKey> = {
  intern: 'prep.seniority.intern',
  junior: 'prep.seniority.junior',
  middle: 'prep.seniority.middle',
  senior: 'prep.seniority.senior',
  lead: 'prep.seniority.lead',
  unknown: 'prep.seniority.unknown',
};

const IMPORTANCE_TONE: Record<TopicImportance, string> = {
  high: 'prep-tone-red',
  medium: 'prep-tone-blue',
  low: 'prep-tone-violet',
};

const IMPORTANCE_KEY: Record<TopicImportance, I18nKey> = {
  high: 'prep.importance.high',
  medium: 'prep.importance.medium',
  low: 'prep.importance.low',
};

/** Render order: gaps first — that is what the interview will drill into. */
const MATCH_GROUPS: Array<{ match: ResumeMatch; titleKey: I18nKey; color: string }> = [
  { match: 'gap', titleKey: 'prep.match.gap', color: 'var(--prep-red)' },
  { match: 'partial', titleKey: 'prep.match.partial', color: 'var(--prep-amber)' },
  { match: 'strong', titleKey: 'prep.match.strong', color: 'var(--prep-green)' },
];

const EXPECTED_LEVEL_KEY: Record<Competency['expectedLevel'], I18nKey> = {
  basic: 'prep.level.basic',
  practical: 'prep.level.practical',
  advanced: 'prep.level.advanced',
  lead: 'prep.level.lead',
};

export default function VacancyAnalysisView({ analysis, onStart, onBack, questionCount }: Props) {
  const { t, lang } = useI18n();
  const pl = (n: number, ru: [I18nKey, I18nKey, I18nKey], en: [I18nKey, I18nKey]) =>
    lang === 'en' ? (n === 1 ? t(en[0]) : t(en[1])) : pluralRu(n, t(ru[0]), t(ru[1]), t(ru[2]));
  // По умолчанию отмечены все темы; ученик снимает те, где уже уверен.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(analysis.interviewTopics.map((topic) => topic.id)),
  );
  const toggleTopic = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = selected.size === analysis.interviewTopics.length;
  // Сколько вопросов даст выбранный набор тем (весь набор → исходный questionCount).
  const plannedCount = useMemo(
    () => (allSelected ? questionCount : buildSmokePlan(analysis, [...selected]).length),
    [allSelected, analysis, selected, questionCount],
  );
  return (
    <div className="prep-rise space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="prep-eyebrow">{t('prep.analysis.basedOn')}</p>
          <h1 className="prep-h1 mt-1">{analysis.targetRole}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="prep-chip prep-tone-violet">{t(SENIORITY_KEY[analysis.seniorityLevel])}</span>
            <span className="prep-chip">
              {analysis.interviewTopics.length}{' '}
              {pl(
                analysis.interviewTopics.length,
                ['prep.topicOne', 'prep.topicFew', 'prep.topicMany'],
                ['prep.topicOne', 'prep.topicFew'],
              )}
            </span>
            <span className="prep-chip">{t('prep.analysis.answers')} {analysis.language.toUpperCase()}</span>
          </div>
        </div>
        <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onBack}>
          {t('prep.analysis.changeVacancy')}
        </button>
      </div>

      {analysis.analysisSource === 'heuristic' && (
        <div className="prep-card prep-card-pad prep-topic prep-topic-amber">
          <p className="prep-h2 pl-2">{t('prep.analysis.heuristicTitle')}</p>
          <p className="prep-sub mt-1.5 pl-2">{t('prep.analysis.heuristicBody')}</p>
          <div className="mt-2.5 pl-2">
            <Link to="/settings?tab=ai" className="prep-btn prep-btn-sm inline-block">
              {t('prep.analysis.connectKey')}
            </Link>
          </div>
        </div>
      )}

      {analysis.riskAreas.length > 0 && (
        <div className="prep-card prep-card-pad prep-topic prep-topic-amber">
          <p className="prep-h2 pl-2">{t('prep.analysis.beforeStart')}</p>
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

      {analysis.competencies && analysis.competencies.length > 0 && (
        <div>
          <h2 className="prep-h2">{t('prep.analysis.competencies')}</h2>
          <p className="prep-faint mt-0.5">{t('prep.analysis.competenciesDesc')}</p>
          <div className="mt-3 space-y-4">
            {MATCH_GROUPS.map((group) => {
              const items = analysis.competencies!.filter((c) => c.resumeMatch === group.match);
              if (!items.length) return null;
              return (
                <div key={group.match}>
                  <p
                    className="text-[11px] font-extrabold uppercase tracking-wider"
                    style={{ color: group.color }}
                  >
                    {t(group.titleKey)} · {items.length}
                  </p>
                  <div className="mt-2 grid gap-2">
                    {items.map((c) => (
                      <div
                        key={c.name}
                        className="prep-card flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3"
                      >
                        <span className={`prep-chip shrink-0 ${IMPORTANCE_TONE[c.priority]}`}>
                          {t(IMPORTANCE_KEY[c.priority])}
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate text-[14px] font-semibold"
                          style={{ color: 'var(--prep-ink)' }}
                        >
                          {c.name}
                        </span>
                        <span className="prep-faint shrink-0">
                          {t('prep.analysis.expected')} {t(EXPECTED_LEVEL_KEY[c.expectedLevel])}
                        </span>
                        {c.note && (
                          <p className="w-full text-[12.5px]" style={{ color: 'var(--prep-ink-muted)' }}>
                            {c.note}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <h2 className="prep-h2">{t('prep.analysis.readinessMap')}</h2>
        <p className="prep-faint mt-0.5">{t('prep.analysis.readinessDesc')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {analysis.interviewTopics.map((topic) => {
            const on = selected.has(topic.id);
            return (
              <div
                key={topic.id}
                role="checkbox"
                aria-checked={on}
                tabIndex={0}
                onClick={() => toggleTopic(topic.id)}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    toggleTopic(topic.id);
                  }
                }}
                className="prep-card cursor-pointer p-4 transition-all"
                style={{
                  opacity: on ? 1 : 0.5,
                  borderColor: on ? 'var(--prep-green)' : undefined,
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span
                      aria-hidden
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border"
                      style={{
                        borderColor: on ? 'var(--prep-green)' : 'var(--prep-border-strong)',
                        background: on ? 'var(--prep-green)' : 'transparent',
                      }}
                    >
                      {on && (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#04240f" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="prep-faint">{topic.category}</p>
                      <p className="prep-h2 truncate">{topic.title}</p>
                    </div>
                  </div>
                  <span className={`prep-chip shrink-0 ${IMPORTANCE_TONE[topic.importance]}`}>
                    {t(IMPORTANCE_KEY[topic.importance])}
                  </span>
                </div>
                <p className="prep-sub mt-2">{topic.expectedKnowledge}</p>
                {topic.whyAsked && <p className="prep-faint mt-1.5">{topic.whyAsked}</p>}
                <p className="mt-2 text-[12px] italic" style={{ color: 'var(--prep-ink-faint)' }}>
                  “{topic.vacancyEvidence}”
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {analysis.extractedRequirements.length > 0 && (
        <div className="prep-card prep-card-pad">
          <p className="prep-h2">{t('prep.analysis.keyRequirements')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {analysis.extractedRequirements.map((r) => (
              <span key={r} className="prep-chip">
                {r}
              </span>
            ))}
            {analysis.optionalSkills.map((r) => (
              <span key={r} className="prep-chip prep-tone-violet">
                {r} · {t('prep.analysis.optional')}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="prep-btn"
          onClick={() => onStart([...selected])}
          disabled={plannedCount === 0}
        >
          {t('prep.analysis.startMock')} {plannedCount}{' '}
          {pl(
            plannedCount,
            ['prep.questionOne', 'prep.questionFew', 'prep.questionMany'],
            ['prep.questionOne', 'prep.questionFew'],
          )}
        </button>
        <span className="prep-faint">
          {selected.size === 0
            ? t('prep.analysis.selectAtLeastOne')
            : `${selected.size} ${t('home.report.of')} ${analysis.interviewTopics.length} ${t('prep.analysis.topicsWord')} · ~20–30 ${t('prep.analysis.min')}`}
        </span>
      </div>
    </div>
  );
}
