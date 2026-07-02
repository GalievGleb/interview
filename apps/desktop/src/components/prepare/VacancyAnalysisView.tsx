import { pluralRu } from '../../lib/pluralRu';
import type {
  Competency,
  ResumeMatch,
  TopicImportance,
  VacancyAnalysis,
} from '../../lib/vacancyReview/types';

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
  unknown: 'Не указано',
};

const IMPORTANCE_TONE: Record<TopicImportance, string> = {
  high: 'prep-tone-red',
  medium: 'prep-tone-blue',
  low: 'prep-tone-violet',
};

const IMPORTANCE_LABEL: Record<TopicImportance, string> = {
  high: 'высокая важность',
  medium: 'средняя важность',
  low: 'низкая важность',
};

/** Render order: gaps first — that is what the interview will drill into. */
const MATCH_GROUPS: Array<{ match: ResumeMatch; title: string; color: string }> = [
  { match: 'gap', title: 'Пробелы — спросят строже', color: 'var(--prep-red)' },
  { match: 'partial', title: 'Смежный опыт', color: 'var(--prep-amber)' },
  { match: 'strong', title: 'Резюме подтверждает', color: 'var(--prep-green)' },
];

const EXPECTED_LEVEL_LABEL: Record<Competency['expectedLevel'], string> = {
  basic: 'теория',
  practical: 'руками',
  advanced: 'проектировал',
  lead: 'стратегия / люди',
};

export default function VacancyAnalysisView({ analysis, onStart, onBack, questionCount }: Props) {
  return (
    <div className="prep-rise space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="prep-eyebrow">На основе этой вакансии</p>
          <h1 className="prep-h1 mt-1">{analysis.targetRole}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="prep-chip prep-tone-violet">{SENIORITY_LABEL[analysis.seniorityLevel]}</span>
            <span className="prep-chip">
              {analysis.interviewTopics.length}{' '}
              {pluralRu(analysis.interviewTopics.length, 'тема', 'темы', 'тем')}
            </span>
            <span className="prep-chip">Ответы: {analysis.language.toUpperCase()}</span>
          </div>
        </div>
        <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onBack}>
          Изменить вакансию
        </button>
      </div>

      {analysis.riskAreas.length > 0 && (
        <div className="prep-card prep-card-pad prep-topic prep-topic-amber">
          <p className="prep-h2 pl-2">Перед началом</p>
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
          <h2 className="prep-h2">Компетенции против резюме</h2>
          <p className="prep-faint mt-0.5">
            Что важно для роли и где вы это подтверждаете. Красное и жёлтое спросят строже.
          </p>
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
                    {group.title} · {items.length}
                  </p>
                  <div className="mt-2 grid gap-2">
                    {items.map((c) => (
                      <div
                        key={c.name}
                        className="prep-card flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3"
                      >
                        <span className={`prep-chip shrink-0 ${IMPORTANCE_TONE[c.priority]}`}>
                          {IMPORTANCE_LABEL[c.priority]}
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate text-[14px] font-semibold"
                          style={{ color: 'var(--prep-ink)' }}
                        >
                          {c.name}
                        </span>
                        <span className="prep-faint shrink-0">
                          ждут: {EXPECTED_LEVEL_LABEL[c.expectedLevel]}
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
        <h2 className="prep-h2">Карта готовности к интервью</h2>
        <p className="prep-faint mt-0.5">Темы извлечены из вакансии — именно это проверит mock-интервью.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {analysis.interviewTopics.map((t) => (
            <div key={t.id} className="prep-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="prep-faint">{t.category}</p>
                  <p className="prep-h2 truncate">{t.title}</p>
                </div>
                <span className={`prep-chip shrink-0 ${IMPORTANCE_TONE[t.importance]}`}>
                  {IMPORTANCE_LABEL[t.importance]}
                </span>
              </div>
              <p className="prep-sub mt-2">{t.expectedKnowledge}</p>
              {t.whyAsked && (
                <p className="prep-faint mt-1.5">{t.whyAsked}</p>
              )}
              <p className="mt-2 text-[12px] italic" style={{ color: 'var(--prep-ink-faint)' }}>
                “{t.vacancyEvidence}”
              </p>
            </div>
          ))}
        </div>
      </div>

      {analysis.extractedRequirements.length > 0 && (
        <div className="prep-card prep-card-pad">
          <p className="prep-h2">Ключевые требования</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {analysis.extractedRequirements.map((r) => (
              <span key={r} className="prep-chip">
                {r}
              </span>
            ))}
            {analysis.optionalSkills.map((r) => (
              <span key={r} className="prep-chip prep-tone-violet">
                {r} · опционально
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button type="button" className="prep-btn" onClick={onStart} disabled={questionCount === 0}>
          Начать mock-интервью: {questionCount} вопросов
        </button>
        <span className="prep-faint">~20–30 мин · сложность растёт</span>
      </div>
    </div>
  );
}
