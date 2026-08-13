import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  FileText,
  FileUser,
  Link2,
  Loader2,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { api, type DocumentItem } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { growthRoleLabel, readGrowthProfile } from '../../lib/growthProfile';
import {
  hhVacancyUrlFromInput,
  hhVacancyUrlFromStandaloneInput,
  mergeVacancyWithAdditionalContext,
} from '../../lib/vacancyInput';
import { listSessions } from '../../lib/vacancyReview/vacancyReviewStore';
import type { AnswerLanguage, VacancyReviewInput } from '../../lib/vacancyReview/types';
import type { HhApplicantResume } from '../../types/electron';

interface Props {
  onAnalyze: (input: VacancyReviewInput) => void;
  analyzing: boolean;
  error?: string;
  initialVacancyUrl?: string;
  initialResumeTitle?: string;
}

const RESUME_SOURCE_STORAGE_KEY = 'skillcue.prepare.resume-source';
const PREPARE_DRAFT_STORAGE_KEY = 'skillcue.prepare.draft.v1';

interface PrepareDraft {
  vacancyUrl?: string;
  vacancyText?: string;
  targetRole?: string;
  language?: AnswerLanguage;
  resumeSource?: string;
}

function readPrepareDraft(): PrepareDraft {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PREPARE_DRAFT_STORAGE_KEY) || '') as PrepareDraft;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const readableError = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '') || fallback;
};

export default function VacancySetup({
  onAnalyze,
  analyzing,
  error,
  initialVacancyUrl = '',
  initialResumeTitle = '',
}: Props) {
  const { t } = useI18n();
  const assistant = window.electronAPI?.hhAssistant;
  const initialDraft = useMemo(readPrepareDraft, []);
  const goalRoleLabel = useMemo(() => growthRoleLabel(readGrowthProfile()), []);
  const reusableResumeSessions = useMemo(
    () => listSessions().filter((session) => session.vacancyAnalysis.resumeText?.trim()),
    [],
  );
  const [vacancyUrl, setVacancyUrl] = useState(initialVacancyUrl || initialDraft.vacancyUrl || '');
  const [vacancyText, setVacancyText] = useState(initialDraft.vacancyText || '');
  const [vacancyImportError, setVacancyImportError] = useState('');
  const [importingVacancy, setImportingVacancy] = useState(false);
  const [targetRole, setTargetRole] = useState(initialDraft.targetRole || goalRoleLabel);
  const [language, setLanguage] = useState<AnswerLanguage>(initialDraft.language || 'ru');
  const [resumeText, setResumeText] = useState('');
  const [legendText, setLegendText] = useState('');
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [hhResumes, setHhResumes] = useState<HhApplicantResume[]>([]);
  const [resumeSource, setResumeSource] = useState(initialDraft.resumeSource || '');
  const [resumeLoading, setResumeLoading] = useState(true);
  const [resumeError, setResumeError] = useState('');
  const vacancyUrlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const initialize = async () => {
      setResumeLoading(true);
      const documentResult = await api.listDocuments().catch(() => ({ documents: [] }));
      if (!alive) return;
      setDocs(documentResult.documents);
      const latest = (kind: string) => documentResult.documents.find((document) => document.kind === kind);

      for (const [document, setter] of [
        [initialVacancyUrl || initialDraft.vacancyUrl || initialDraft.vacancyText ? undefined : latest('vacancy'), setVacancyText],
        [latest('legend'), setLegendText],
      ] as const) {
        if (!document) continue;
        try {
          const full = await api.getDocument(document.id);
          if (alive && full.text.trim()) setter(full.text);
        } catch {
          // Saved context is optional; the form remains usable.
        }
      }

      let foundHhResumes: HhApplicantResume[] = [];
      let preferredHhTitle = '';
      if (assistant) {
        try {
          const state = await assistant.getState();
          preferredHhTitle = state.config.resumeTitles[0] ?? '';
          foundHhResumes = await assistant.getResumes();
          if (alive) setHhResumes(foundHhResumes);
        } catch (loadError) {
          if (alive) {
            setResumeError(readableError(loadError, 'Не удалось получить резюме из HH.'));
          }
        }
      }

      if (!alive) return;
      const localResumes = documentResult.documents.filter((document) => document.kind === 'resume');
      let stored = '';
      try { stored = localStorage.getItem(RESUME_SOURCE_STORAGE_KEY) ?? ''; } catch { /* noop */ }
      const storedExists = stored === 'none' || stored === 'manual'
        || (stored.startsWith('hh:') && foundHhResumes.some((resume) => `hh:${resume.id}` === stored))
        || (stored.startsWith('doc:') && localResumes.some((document) => `doc:${document.id}` === stored))
        || (stored.startsWith('session:') && reusableResumeSessions.some((session) => `session:${session.id}` === stored));
      const preferredHh = foundHhResumes.find((resume) => resume.title === preferredHhTitle)
        ?? foundHhResumes[0];
      const requestedSource = initialResumeTitle
        ? foundHhResumes.find((resume) => resume.title === initialResumeTitle)
          ? `hh:${foundHhResumes.find((resume) => resume.title === initialResumeTitle)!.id}`
          : localResumes.find((document) => document.title === initialResumeTitle)
            ? `doc:${localResumes.find((document) => document.title === initialResumeTitle)!.id}`
            : reusableResumeSessions.find((session) => session.vacancyAnalysis.resumeSource?.title === initialResumeTitle)
              ? `session:${reusableResumeSessions.find((session) => session.vacancyAnalysis.resumeSource?.title === initialResumeTitle)!.id}`
              : ''
        : '';
      const source = requestedSource || (storedExists
        ? stored
        : preferredHh
          ? `hh:${preferredHh.id}`
          : localResumes[0]
            ? `doc:${localResumes[0].id}`
            : reusableResumeSessions[0]
              ? `session:${reusableResumeSessions[0].id}`
              : 'none');
      setResumeSource(source);

      try {
        if (source.startsWith('hh:') && assistant) {
          const resume = await assistant.getResumeContent(source.slice(3));
          if (alive) {
            setResumeText(resume.text);
            setResumeError('');
          }
        } else if (source.startsWith('doc:')) {
          const resume = await api.getDocument(source.slice(4));
          if (alive) setResumeText(resume.text);
        } else if (source.startsWith('session:')) {
          const session = reusableResumeSessions.find((item) => item.id === source.slice(8));
          if (alive) setResumeText(session?.vacancyAnalysis.resumeText ?? '');
        }
      } catch (loadError) {
        if (alive) setResumeError(readableError(loadError, 'Не удалось загрузить выбранное резюме.'));
      } finally {
        if (alive) setResumeLoading(false);
      }
    };
    void initialize();
    return () => { alive = false; };
  }, [assistant, initialResumeTitle, initialVacancyUrl, initialDraft.vacancyText, initialDraft.vacancyUrl, reusableResumeSessions]);

  const selectResumeSource = async (source: string) => {
    setResumeSource(source);
    setResumeError('');
    try { localStorage.setItem(RESUME_SOURCE_STORAGE_KEY, source); } catch { /* noop */ }
    if (source === 'none' || source === 'manual') {
      setResumeText('');
      return;
    }
    setResumeLoading(true);
    try {
      if (source.startsWith('hh:')) {
        if (!assistant) throw new Error('Интеграция с HH недоступна.');
        const resume = await assistant.getResumeContent(source.slice(3));
        setResumeText(resume.text);
      } else if (source.startsWith('doc:')) {
        const resume = await api.getDocument(source.slice(4));
        setResumeText(resume.text);
      } else if (source.startsWith('session:')) {
        const session = reusableResumeSessions.find((item) => item.id === source.slice(8));
        setResumeText(session?.vacancyAnalysis.resumeText ?? '');
      }
    } catch (loadError) {
      setResumeText('');
      setResumeError(readableError(loadError, 'Не удалось загрузить выбранное резюме.'));
    } finally {
      setResumeLoading(false);
    }
  };

  const detectedVacancyUrl = useMemo(
    () => hhVacancyUrlFromInput(vacancyUrl) || hhVacancyUrlFromInput(vacancyText),
    [vacancyText, vacancyUrl],
  );
  const resumeReady = Boolean(resumeText.trim());
  const legendReady = Boolean(legendText.trim());
  const hasVacancyInput = Boolean(detectedVacancyUrl || vacancyText.trim().length > 20);
  const canAnalyze = !analyzing && !importingVacancy && !resumeLoading;
  const selectedResumeTitle = resumeSource.startsWith('hh:')
    ? hhResumes.find((resume) => `hh:${resume.id}` === resumeSource)?.title
    : resumeSource.startsWith('doc:')
      ? docs.find((document) => `doc:${document.id}` === resumeSource)?.title
      : resumeSource.startsWith('session:')
        ? reusableResumeSessions.find((session) => `session:${session.id}` === resumeSource)?.vacancyAnalysis.resumeSource?.title
          || reusableResumeSessions.find((session) => `session:${session.id}` === resumeSource)?.vacancyAnalysis.targetRole
      : resumeSource === 'manual'
        ? 'Введено вручную'
        : '';

  const submit = async () => {
    if (!canAnalyze) return;
    if (!hasVacancyInput) {
      setVacancyImportError('Добавьте ссылку HH или вставьте описание вакансии — хотя бы пару предложений.');
      vacancyUrlRef.current?.focus();
      return;
    }
    setVacancyImportError('');
    let resolvedVacancyText = vacancyText.trim();
    let resolvedRole = targetRole.trim();
    let vacancyCompany: string | undefined;
    if (detectedVacancyUrl) {
      if (!assistant) {
        setVacancyImportError('Импорт с HH доступен только в desktop-приложении.');
        return;
      }
      setImportingVacancy(true);
      try {
        const vacancy = await assistant.inspectVacancyUrl(detectedVacancyUrl);
        resolvedVacancyText = mergeVacancyWithAdditionalContext(vacancy.text, resolvedVacancyText);
        if (!resolvedRole || resolvedRole === goalRoleLabel) resolvedRole = vacancy.title;
        vacancyCompany = vacancy.company || undefined;
        setVacancyUrl(vacancy.url);
        setVacancyText(resolvedVacancyText);
        setTargetRole(resolvedRole);
      } catch (loadError) {
        setVacancyImportError(readableError(loadError, 'Не удалось загрузить вакансию с HH.'));
        setImportingVacancy(false);
        return;
      }
    }
    onAnalyze({
      vacancyText: resolvedVacancyText,
      vacancyUrl: detectedVacancyUrl || undefined,
      vacancyCompany,
      targetRole: resolvedRole || undefined,
      language,
      resumeText: resumeReady ? resumeText.trim() : undefined,
      resumeSource: resumeReady ? {
        kind: resumeSource.startsWith('hh:')
          ? 'hh'
          : resumeSource.startsWith('doc:')
            ? 'document'
            : resumeSource.startsWith('session:')
              ? 'session'
              : 'manual',
        id: resumeSource.includes(':') ? resumeSource.split(':', 2)[1] : undefined,
        title: selectedResumeTitle || 'Резюме, введённое вручную',
      } : undefined,
      legendText: legendReady ? legendText.trim() : undefined,
    });
    try { sessionStorage.removeItem(PREPARE_DRAFT_STORAGE_KEY); } catch { /* noop */ }
    setImportingVacancy(false);
  };

  if (analyzing || importingVacancy) {
    return (
      <div className="prep-rise">
        <div className="prep-analyzing-panel" role="status" aria-live="polite">
          <span className="prep-analyzing-panel__icon" aria-hidden="true">
            {importingVacancy ? <Link2 size={22} /> : <BriefcaseBusiness size={22} />}
          </span>
          <div>
            <p className="prep-eyebrow">{t('prep.setup.progressEyebrow')}</p>
            <h1 className="prep-h1 mt-1">
              {importingVacancy ? 'Читаю вакансию с HH…' : t('prep.analyzing.title')}
            </h1>
            <p className="prep-sub mt-2">
              {importingVacancy
                ? 'Получаю полное описание. Никакой отклик при этом не отправляется.'
                : t('prep.analyzing.sub')}
            </p>
          </div>
          <div className="prep-analyzing-steps">
            <span className="prep-analyzing-step">{importingVacancy ? 'Название и компания' : t('prep.analyzing.step1')}</span>
            <span className="prep-analyzing-step">{importingVacancy ? 'Требования и задачи' : t('prep.analyzing.step2')}</span>
            <span className="prep-analyzing-step">{importingVacancy ? 'Сопоставление с резюме' : t('prep.analyzing.step3')}</span>
          </div>
          <div className="prep-shimmer" aria-hidden="true" />
        </div>
      </div>
    );
  }

  return (
    <div className="prep-rise space-y-5">
      <header className="prep-page-heading">
        <p className="prep-eyebrow">{t('prep.setup.eyebrow')}</p>
        <h1 className="prep-h1 mt-1">{t('prep.title')}</h1>
        <p className="prep-sub mt-2 max-w-2xl">
          Вставьте ссылку HH или описание. Отклик при разборе не отправляется.
        </p>
      </header>

      <form
        className="prep-setup-shell"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        onKeyDown={(event) => {
          if (event.ctrlKey && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <div className="prep-setup-main">
          <div className="prep-field-heading">
            <span className="prep-field-heading__icon" aria-hidden="true"><Link2 size={18} /></span>
            <div>
              <label htmlFor="vacancy-url" className="prep-h2">Ссылка на вакансию HH</label>
              <p className="prep-faint mt-0.5">SkillCue загрузит описание без открытия формы отклика.</p>
            </div>
          </div>

          <input
            ref={vacancyUrlRef}
            id="vacancy-url"
            className="prep-input mt-4 w-full"
            placeholder="https://hh.ru/vacancy/123456"
            name="vacancyUrl"
            autoComplete="off"
            value={vacancyUrl}
            onChange={(event) => {
              setVacancyUrl(event.target.value);
              setVacancyImportError('');
            }}
            autoFocus
          />
          {detectedVacancyUrl && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-300">
              <Check size={14} /> Ссылка HH распознана — загрузим вакансию автоматически
            </p>
          )}

          <div className="my-4 flex items-center gap-3 text-xs text-ink-faint">
            <span className="h-px flex-1 bg-surface-border" />или вставьте описание вручную<span className="h-px flex-1 bg-surface-border" />
          </div>
          <label htmlFor="vacancy-text" className="sr-only">{t('prep.vacancyLabel')}</label>
          <textarea
            id="vacancy-text"
            className="prep-textarea prep-vacancy-textarea"
            placeholder={t('prep.vacancyPlaceholder')}
            name="vacancyText"
            autoComplete="off"
            value={vacancyText}
            onChange={(event) => {
              const nextText = event.target.value;
              const standaloneUrl = hhVacancyUrlFromStandaloneInput(nextText);
              if (standaloneUrl) {
                setVacancyUrl(standaloneUrl);
                setVacancyText('');
              } else {
                setVacancyText(nextText);
              }
              setVacancyImportError('');
            }}
          />

          {(error || vacancyImportError) && (
            <p className="prep-inline-error mt-3" role="alert">{vacancyImportError || error}</p>
          )}

          <div className="prep-setup-submit">
            <p className="prep-faint">
              {resumeLoading
                ? 'Загружаю выбранное резюме…'
                : hasVacancyInput
                  ? resumeReady
                    ? 'Вакансия будет сопоставлена с выбранным резюме.'
                    : 'Разбор запустится без сравнения с резюме.'
                  : t('prep.needText')}
            </p>
            <button type="submit" className="prep-btn" disabled={!canAnalyze}>
              {detectedVacancyUrl ? 'Загрузить с HH и разобрать' : t('home.action.reviewVacancy')}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <aside className="prep-setup-aside" aria-label={t('prep.setup.contextTitle')}>
          <div>
            <p className="prep-eyebrow">Контекст кандидата</p>
            <h2 className="prep-h2 mt-1">Резюме для этого разбора</h2>
          </div>

          <label className="block">
            <span className="prep-faint">Источник резюме</span>
            <span className="relative mt-1 block">
              <select
                className="prep-input w-full pr-9"
                value={resumeSource}
                disabled={resumeLoading}
                onChange={(event) => void selectResumeSource(event.target.value)}
              >
                {hhResumes.length > 0 && (
                  <optgroup label="Резюме из HH.ru">
                    {hhResumes.map((resume) => <option key={resume.id} value={`hh:${resume.id}`}>{resume.title}</option>)}
                  </optgroup>
                )}
                {docs.some((document) => document.kind === 'resume') && (
                  <optgroup label="Загруженные в SkillCue">
                    {docs.filter((document) => document.kind === 'resume').map((document) => (
                      <option key={document.id} value={`doc:${document.id}`}>{document.title}</option>
                    ))}
                  </optgroup>
                )}
                {reusableResumeSessions.length > 0 && (
                  <optgroup label="Из прошлых разборов">
                    {reusableResumeSessions.map((session) => (
                      <option key={session.id} value={`session:${session.id}`}>
                        {session.vacancyAnalysis.resumeSource?.title || `Резюме · ${session.vacancyAnalysis.targetRole}`}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="manual">Вставить резюме вручную</option>
                <option value="none">Без резюме</option>
              </select>
              {resumeLoading && <Loader2 className="absolute right-3 top-2.5 animate-spin text-ink-faint" size={16} />}
            </span>
          </label>

          {resumeSource === 'manual' && (
            <textarea
              className="prep-textarea"
              style={{ minHeight: 130 }}
              aria-label="Резюме"
              placeholder={t('prep.resumePlaceholder')}
              value={resumeText}
              onChange={(event) => setResumeText(event.target.value)}
            />
          )}

          <SetupStatus
            icon={FileUser}
            title={t('docs.kind.resume')}
            detail={resumeLoading ? 'Загружается…' : resumeReady ? selectedResumeTitle || t('prep.setup.connected') : t('prep.setup.notConnected')}
            ready={resumeReady}
          />
          <SetupStatus
            icon={FileText}
            title={t('docs.kind.legend')}
            detail={legendReady ? t('prep.setup.connected') : t('prep.setup.notConnected')}
            ready={legendReady}
          />

          {resumeError && !resumeReady && (
            <div className="prep-inline-error text-xs" role="alert">
              {resumeError}{' '}
              <Link to="/applications" className="underline underline-offset-2">Проверить подключение HH</Link>
            </div>
          )}

          <details className="prep-disclosure">
            <summary><span><Settings2 size={15} />{t('prep.setup.options')}</span><ChevronDown size={15} /></summary>
            <div className="prep-disclosure__body">
              <label htmlFor="target-role" className="prep-faint">{t('prep.roleLabel')}</label>
              <input id="target-role" className="prep-input mt-1 w-full" placeholder={t('prep.rolePlaceholder')} value={targetRole} onChange={(event) => setTargetRole(event.target.value)} />
              <fieldset className="mt-4">
                <legend className="prep-faint">{t('prep.answerLangLabel')}</legend>
                <div className="prep-segmented mt-1">
                  {(['ru', 'en'] as AnswerLanguage[]).map((option) => (
                    <button key={option} type="button" aria-pressed={language === option} className={language === option ? 'is-active' : ''} onClick={() => setLanguage(option)}>{option.toUpperCase()}</button>
                  ))}
                </div>
              </fieldset>
            </div>
          </details>

          <details className="prep-disclosure">
            <summary><span><FileText size={15} />Легенда для интервью</span><ChevronDown size={15} /></summary>
            <div className="prep-disclosure__body">
              <ContextEditor
                label={t('docs.kind.legend')}
                value={legendText}
                placeholder={t('prep.legendPlaceholder')}
                docs={docs.filter((document) => document.kind === 'legend')}
                onChange={setLegendText}
                onPick={async (id) => {
                  try { setLegendText((await api.getDocument(id)).text); } catch { /* noop */ }
                }}
              />
            </div>
          </details>

          <Link
            to="/documents?next=prepare"
            className="prep-link-btn"
            onClick={() => {
              try {
                sessionStorage.setItem(PREPARE_DRAFT_STORAGE_KEY, JSON.stringify({
                  vacancyUrl,
                  vacancyText,
                  targetRole,
                  language,
                  resumeSource,
                } satisfies PrepareDraft));
              } catch { /* noop */ }
            }}
          >
            Управлять локальными документами<ArrowRight size={14} />
          </Link>
        </aside>
      </form>
    </div>
  );
}

function SetupStatus({ icon: Icon, title, detail, ready }: { icon: LucideIcon; title: string; detail: string; ready: boolean }) {
  return (
    <div className="prep-setup-status">
      <span className={`prep-setup-status__icon ${ready ? 'is-ready' : ''}`}><Icon size={15} /></span>
      <span className="min-w-0 flex-1"><strong>{title}</strong><small>{detail}</small></span>
      {ready && <Check size={15} aria-label={detail} />}
    </div>
  );
}

function ContextEditor({ label, value, placeholder, docs, onChange, onPick }: {
  label: string;
  value: string;
  placeholder: string;
  docs: DocumentItem[];
  onChange: (value: string) => void;
  onPick: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <label className="prep-faint">{label}</label>
      {docs.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          <span className="prep-faint self-center">{t('prep.savedDocs')}</span>
          {docs.slice(0, 4).map((document) => (
            <button key={document.id} type="button" className="prep-chip prep-doc-chip" title={document.title} onClick={() => onPick(document.id)}>{document.title.slice(0, 22)}</button>
          ))}
        </div>
      )}
      <textarea className="prep-textarea mt-2" style={{ minHeight: 110 }} aria-label={label} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
