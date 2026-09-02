import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ExternalLink,
  Pencil,
  ShieldCheck,
} from 'lucide-react';
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
  onStart: (topicIds: string[]) => void;
  onBack: () => void;
  onRetry: () => void;
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

const MATCH_GROUPS: Array<{ match: ResumeMatch; titleKey: I18nKey; tone: string }> = [
  { match: 'unknown', titleKey: 'prep.match.unknown', tone: 'blue' },
  { match: 'gap', titleKey: 'prep.match.gap', tone: 'red' },
  { match: 'partial', titleKey: 'prep.match.partial', tone: 'amber' },
  { match: 'strong', titleKey: 'prep.match.strong', tone: 'green' },
];

const EXPECTED_LEVEL_KEY: Record<Competency['expectedLevel'], I18nKey> = {
  basic: 'prep.level.basic',
  practical: 'prep.level.practical',
  advanced: 'prep.level.advanced',
  lead: 'prep.level.lead',
};

export default function VacancyAnalysisView({
  analysis,
  onStart,
  onBack,
  onRetry,
  questionCount,
}: Props) {
  const { t, lang } = useI18n();
  const pl = (n: number, ru: [I18nKey, I18nKey, I18nKey], en: [I18nKey, I18nKey]) =>
    lang === 'en'
      ? n === 1
        ? t(en[0])
        : t(en[1])
      : pluralRu(n, t(ru[0]), t(ru[1]), t(ru[2]));
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(analysis.interviewTopics.map((topic) => topic.id)),
  );

  const toggleTopic = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = selected.size === analysis.interviewTopics.length;
  const plannedCount = useMemo(
    () => (allSelected ? questionCount : buildSmokePlan(analysis, [...selected]).length),
    [allSelected, analysis, selected, questionCount],
  );
  const competencies = analysis.competencies ?? [];
  const rolePractice = analysis.contextKind === 'role';
  const localAnalysisBody = analysis.analysisError === 'timeout'
    ? t('prep.analysis.heuristicTimeout')
    : analysis.analysisError === 'offline'
      ? t('prep.analysis.heuristicOffline')
      : analysis.analysisError === 'quota'
        ? t('prep.analysis.heuristicQuota')
        : analysis.analysisError === 'empty'
          ? t('prep.analysis.heuristicEmpty')
          : t('prep.analysis.heuristicBody');

  return (
    <div className="prep-rise space-y-5">
      <header className="prep-analysis-heading">
        <div className="min-w-0">
          <p className="prep-eyebrow">{rolePractice ? 'ПРАКТИКА ПО РОЛИ' : t('prep.analysis.basedOn')}</p>
          <h1 className="prep-h1 mt-1">{analysis.targetRole}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="prep-chip prep-tone-violet">
              {t(SENIORITY_KEY[analysis.seniorityLevel])}
            </span>
            <span className="prep-chip">
              {analysis.interviewTopics.length}{' '}
              {pl(
                analysis.interviewTopics.length,
                ['prep.topicOne', 'prep.topicFew', 'prep.topicMany'],
                ['prep.topicOne', 'prep.topicFew'],
              )}
            </span>
            <span className="prep-chip">
              {t('prep.analysis.answers')} {analysis.language.toUpperCase()}
            </span>
            {analysis.vacancyUrl && (
              <button
                type="button"
                className="prep-chip cursor-pointer hover:border-emerald-400/50 hover:text-emerald-200"
                onClick={() => void window.electronAPI?.openExternal(analysis.vacancyUrl!)}
              >
                {analysis.vacancyCompany || 'HH.ru'} <ExternalLink size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onBack}>
          <Pencil size={14} aria-hidden="true" />
          {rolePractice ? 'Изменить роль' : t('prep.analysis.changeVacancy')}
        </button>
      </header>

      {analysis.analysisSource === 'heuristic' && (
        <div className="prep-analysis-warning" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>{t('prep.analysis.heuristicTitle')}</strong>
            <p>{localAnalysisBody}</p>
          </div>
          <button type="button" className="prep-link-btn" onClick={onRetry}>
            {t('prep.analysis.retryAi')}
          </button>
        </div>
      )}

      <section className="prep-analysis-shell">
        <div className="prep-analysis-main">
          <div className="prep-analysis-section-heading">
            <div>
              <p className="prep-eyebrow">{rolePractice ? 'ТЕМЫ' : t('prep.analysis.planEyebrow')}</p>
              <h2 className="prep-h2 mt-1">{rolePractice ? 'Что потренировать' : t('prep.analysis.readinessMap')}</h2>
              <p className="prep-faint mt-1">
                {rolePractice ? 'Оставьте только темы, которые хотите проверить сейчас.' : t('prep.analysis.readinessDesc')}
              </p>
            </div>
            <button
              type="button"
              className="prep-link-btn"
              onClick={() =>
                setSelected(
                  allSelected
                    ? new Set()
                    : new Set(analysis.interviewTopics.map((topic) => topic.id)),
                )
              }
            >
              {allSelected ? t('prep.analysis.clearAll') : t('prep.analysis.selectAll')}
            </button>
          </div>

          <div className="prep-analysis-topics">
            {analysis.interviewTopics.map((topic) => {
              const active = selected.has(topic.id);
              return (
                <button
                  key={topic.id}
                  type="button"
                  aria-pressed={active}
                  className={`prep-analysis-topic ${active ? 'is-selected' : ''}`}
                  onClick={() => toggleTopic(topic.id)}
                >
                  <span className="prep-analysis-topic__check" aria-hidden="true">
                    {active && <Check size={13} />}
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="prep-faint">{topic.category}</span>
                    <strong>{topic.title}</strong>
                    <small>{topic.expectedKnowledge}</small>
                  </span>
                  <span className={`prep-chip shrink-0 ${IMPORTANCE_TONE[topic.importance]}`}>
                    {t(IMPORTANCE_KEY[topic.importance])}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <aside className="prep-analysis-aside">
          <div>
            <p className="prep-eyebrow">{rolePractice ? 'КОНТЕКСТ' : t('prep.analysis.riskEyebrow')}</p>
            <h2 className="prep-h2 mt-1">{rolePractice ? 'Перед началом' : t('prep.analysis.beforeStart')}</h2>
          </div>

          {analysis.riskAreas.length > 0 ? (
            <ul className="prep-risk-list">
              {analysis.riskAreas.slice(0, 4).map((risk) => (
                <li key={risk}>
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>{risk}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="prep-analysis-clear">
              <ShieldCheck size={17} aria-hidden="true" />
              <span>{t('prep.analysis.noRisks')}</span>
            </div>
          )}

          {competencies.length > 0 && (
            <div className="prep-match-summary">
              <p className="prep-faint">
                {analysis.hasResume ? t('prep.analysis.competencies') : t('prep.match.unknownHelp')}
              </p>
              {MATCH_GROUPS.map((group) => {
                const count = competencies.filter(
                  (competency) => competency.resumeMatch === group.match,
                ).length;
                return (
                  <div key={group.match}>
                    <span className={`prep-match-dot prep-tone-${group.tone}`} />
                    <span>{t(group.titleKey)}</span>
                    <strong>{count}</strong>
                  </div>
                );
              })}
            </div>
          )}

          <details className="prep-disclosure">
            <summary>
              <span>{t('prep.analysis.details')}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </summary>
            <div className="prep-disclosure__body space-y-4">
              {competencies.length > 0 && (
                <CompetencyDetails competencies={competencies} />
              )}
              {analysis.extractedRequirements.length > 0 && (
                <div>
                  <p className="prep-faint">{t('prep.analysis.keyRequirements')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {analysis.extractedRequirements.map((requirement) => (
                      <span key={requirement} className="prep-chip">
                        {requirement}
                      </span>
                    ))}
                    {analysis.optionalSkills.map((skill) => (
                      <span key={skill} className="prep-chip prep-tone-violet">
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>
        </aside>
      </section>

      <footer className="prep-analysis-action">
        <div>
          <strong>
            {plannedCount}{' '}
            {pl(
              plannedCount,
              ['prep.questionOne', 'prep.questionFew', 'prep.questionMany'],
              ['prep.questionOne', 'prep.questionFew'],
            )}
          </strong>
          <span>
            {selected.size} {t('home.report.of')} {analysis.interviewTopics.length}{' '}
            {t('prep.analysis.topicsWord')}
          </span>
        </div>
        <button
          type="button"
          className="prep-btn"
          onClick={() => onStart([...selected])}
          disabled={plannedCount === 0}
        >
          {plannedCount === 0
            ? t('prep.analysis.selectAtLeastOne')
            : t('prep.analysis.startPractice')}
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </footer>
    </div>
  );
}

function CompetencyDetails({ competencies }: { competencies: Competency[] }) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      {MATCH_GROUPS.map((group) => {
        const items = competencies.filter((competency) => competency.resumeMatch === group.match);
        if (items.length === 0) return null;
        return (
          <div key={group.match}>
            <p className="prep-faint">{t(group.titleKey)}</p>
            <div className="mt-1 space-y-1">
              {items.map((competency) => (
                <div key={competency.name} className="prep-competency-row">
                  <strong>{competency.name}</strong>
                  <small>
                    {t('prep.analysis.expected')}{' '}
                    {t(EXPECTED_LEVEL_KEY[competency.expectedLevel])}
                  </small>
                  {competency.note && <p>{competency.note}</p>}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
