import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, BriefcaseBusiness, Check, ChevronDown, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import {
  GROWTH_ROLES,
  growthRoleLabel,
  readGrowthProfile,
  type GrowthRoleId,
} from '../../lib/growthProfile';
import { resolvePreferredResume } from '../../lib/resumeContext';
import type { AnswerLanguage, ResumeSourceRef, VacancyReviewInput } from '../../lib/vacancyReview/types';

interface Props {
  onAnalyze: (input: VacancyReviewInput) => void;
  analyzing: boolean;
  error?: string;
}

const ROLE_OPTIONS = Object.entries(GROWTH_ROLES) as Array<
  [Exclude<GrowthRoleId, 'custom'>, (typeof GROWTH_ROLES)[Exclude<GrowthRoleId, 'custom'>]]
>;

function practiceBrief(role: string, topics: string[]): string {
  return [
    `Учебная практика для собеседования на роль ${role}.`,
    `Основные темы: ${topics.join(', ')}.`,
    'Проверь практическое понимание, реальные примеры, решения и типичные ошибки кандидата.',
  ].join('\n');
}

export default function GeneralPracticeSetup({ onAnalyze, analyzing, error }: Props) {
  const navigate = useNavigate();
  const savedProfile = useMemo(readGrowthProfile, []);
  const initialRole = savedProfile.role ?? '';
  const [roleId, setRoleId] = useState<GrowthRoleId | ''>(initialRole);
  const [customRole, setCustomRole] = useState(savedProfile.customRole);
  const [language, setLanguage] = useState<AnswerLanguage>('ru');
  const [resumeText, setResumeText] = useState('');
  const [legendText, setLegendText] = useState('');
  const [resumeSource, setResumeSource] = useState<ResumeSourceRef | undefined>();
  const [contextLoading, setContextLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const loadContext = async () => {
      setContextLoading(true);
      const preferred = await resolvePreferredResume();
      const result = await api.listDocuments().catch(() => ({ documents: [] }));
      const legend = result.documents.find((document) => document.kind === 'legend');
      const fullLegend = legend ? await api.getDocument(legend.id).catch(() => null) : null;
      if (!active) return;
      if (preferred.text.trim()) {
        setResumeText(preferred.text);
        setResumeSource(preferred.source);
      } else {
        setResumeText('');
        setResumeSource(undefined);
      }
      if (fullLegend?.text.trim()) setLegendText(fullLegend.text);
      setContextLoading(false);
    };
    void loadContext();
    window.addEventListener('skillcue:candidate-sources-updated', loadContext);
    return () => {
      active = false;
      window.removeEventListener('skillcue:candidate-sources-updated', loadContext);
    };
  }, []);

  const role = !roleId
    ? ''
    : roleId === 'custom'
      ? customRole.trim()
      : GROWTH_ROLES[roleId].label;
  const topics = !roleId
    ? []
    : roleId === 'custom'
      ? savedProfile.customTopics.filter(Boolean)
      : GROWTH_ROLES[roleId].core;
  const canStart = Boolean(role) && !analyzing && !contextLoading;
  const savedRole = growthRoleLabel(savedProfile);

  const start = () => {
    if (!canStart) return;
    const effectiveTopics = topics.length > 0
      ? topics
      : ['практический опыт', 'основные инструменты', 'решение рабочих задач'];
    onAnalyze({
      vacancyText: practiceBrief(role, effectiveTopics),
      contextKind: 'role',
      targetRole: role,
      language,
      resumeText: resumeText.trim() || undefined,
      resumeSource: resumeText.trim() ? resumeSource : undefined,
      legendText: legendText.trim() || undefined,
    });
  };

  if (analyzing) {
    return (
      <section className="practice-start-card" role="status" aria-live="polite">
        <Loader2 className="animate-spin text-emerald-300" size={24} aria-hidden="true" />
        <div>
          <p className="prep-eyebrow">ПРАКТИКА</p>
          <h1 className="prep-h1 mt-1">Готовим вопросы по роли…</h1>
          <p className="prep-sub mt-2">Собираем короткую тренировку без привязки к вакансии.</p>
        </div>
      </section>
    );
  }

  return (
    <div className="prep-rise space-y-5">
      <header className="prep-page-heading">
        <p className="prep-eyebrow">ПРАКТИКА БЕЗ ВАКАНСИИ</p>
        <h1 className="prep-h1 mt-1">Выберите роль и начните</h1>
        <p className="prep-sub mt-2">Вопросы будут по роли; резюме и история опыта подключатся автоматически.</p>
      </header>

      <section className="practice-start-card" aria-labelledby="general-practice-role">
        <span className="practice-start-card__icon" aria-hidden="true"><BriefcaseBusiness size={20} /></span>
        <div className="practice-start-card__body">
          <label className="prep-field-label" htmlFor="general-practice-role-select">
            <span id="general-practice-role">Роль</span>
            <select
              id="general-practice-role-select"
              className="prep-input"
              value={roleId}
              onChange={(event) => setRoleId(event.target.value as GrowthRoleId | '')}
            >
              <option value="">Выберите роль</option>
              {ROLE_OPTIONS.map(([id, definition]) => <option key={id} value={id}>{definition.label}</option>)}
              <option value="custom">Другая роль</option>
            </select>
          </label>
          {roleId === 'custom' && (
            <label className="prep-field-label" htmlFor="general-practice-custom-role">
              <span>Название роли</span>
              <input
                id="general-practice-custom-role"
                className="prep-input"
                value={customRole}
                onChange={(event) => setCustomRole(event.target.value)}
                placeholder="Например, Data Engineer"
              />
            </label>
          )}
          <div className="practice-context-status" role="status">
            <Check size={15} aria-hidden="true" />
            <span>
              {contextLoading
                ? 'Проверяем сохранённый контекст…'
                : resumeText
                  ? 'Резюме подключено'
                  : 'Можно начать без резюме'}
              {savedRole && savedRole !== role ? ` · цель в профиле: ${savedRole}` : ''}
            </span>
          </div>
          <details className="prep-disclosure">
            <summary><span>Темы тренировки · {topics.length || 3}</span><ChevronDown size={15} /></summary>
            <div className="prep-disclosure__body flex flex-wrap gap-2">
              {(topics.length ? topics : ['Практический опыт', 'Инструменты', 'Решение задач']).map((topic) => (
                <span key={topic} className="prep-chip">{topic}</span>
              ))}
            </div>
          </details>
          <fieldset>
            <legend className="prep-faint">Язык ответа</legend>
            <div className="prep-segmented mt-1">
              {(['ru', 'en'] as AnswerLanguage[]).map((option) => (
                <button key={option} type="button" aria-pressed={language === option} className={language === option ? 'is-active' : ''} onClick={() => setLanguage(option)}>
                  {option.toUpperCase()}
                </button>
              ))}
            </div>
          </fieldset>
          {error && <p className="prep-inline-error" role="alert">{error}</p>}
        </div>
        <div className="practice-start-card__actions">
          <button type="button" className="prep-btn" disabled={!canStart} onClick={start}>
            {contextLoading ? 'Загружаем контекст…' : 'Начать практику'} <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button type="button" className="prep-btn prep-btn-ghost" onClick={() => navigate('/prepare')}>
            Практика по вакансии
          </button>
        </div>
      </section>
    </div>
  );
}
