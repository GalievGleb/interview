import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  FileText,
  FileUser,
  Settings2,
  type LucideIcon,
} from 'lucide-react';
import { api, type DocumentItem } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { AnswerLanguage, VacancyReviewInput } from '../../lib/vacancyReview/types';

interface Props {
  onAnalyze: (input: VacancyReviewInput) => void;
  analyzing: boolean;
  error?: string;
}

export default function VacancySetup({ onAnalyze, analyzing, error }: Props) {
  const { t } = useI18n();
  const [vacancyText, setVacancyText] = useState('');
  const [targetRole, setTargetRole] = useState('');
  const [language, setLanguage] = useState<AnswerLanguage>('ru');
  const [resumeText, setResumeText] = useState('');
  const [legendText, setLegendText] = useState('');
  const [docs, setDocs] = useState<DocumentItem[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .listDocuments()
      .then(async (result) => {
        if (!alive) return;
        setDocs(result.documents);
        const latest = (kind: string) => result.documents.find((document) => document.kind === kind);
        const fills: Array<
          [{ id: string } | undefined, React.Dispatch<React.SetStateAction<string>>]
        > = [
          [latest('vacancy'), setVacancyText],
          [latest('resume'), setResumeText],
          [latest('legend'), setLegendText],
        ];

        for (const [document, setValue] of fills) {
          if (!document) continue;
          try {
            const full = await api.getDocument(document.id);
            if (alive && full.text.trim()) {
              setValue((current) => (current.trim() ? current : full.text));
            }
          } catch {
            // The form stays usable when a saved document cannot be loaded.
          }
        }
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, []);

  const loadDoc = async (id: string, into: 'resume' | 'legend') => {
    try {
      const document = await api.getDocument(id);
      (into === 'resume' ? setResumeText : setLegendText)(document.text);
    } catch {
      // The user can still paste context manually.
    }
  };

  const canAnalyze = vacancyText.trim().length > 20 && !analyzing;
  const resumeReady = Boolean(resumeText.trim());
  const legendReady = Boolean(legendText.trim());

  const submit = () => {
    if (!canAnalyze) return;
    onAnalyze({
      vacancyText,
      targetRole: targetRole || undefined,
      language,
      resumeText: resumeReady ? resumeText.trim() : undefined,
      legendText: legendReady ? legendText.trim() : undefined,
    });
  };

  if (analyzing) {
    return (
      <div className="prep-rise">
        <div className="prep-analyzing-panel" role="status" aria-live="polite">
          <span className="prep-analyzing-panel__icon" aria-hidden="true">
            <BriefcaseBusiness size={22} />
          </span>
          <div>
            <p className="prep-eyebrow">{t('prep.setup.progressEyebrow')}</p>
            <h1 className="prep-h1 mt-1">{t('prep.analyzing.title')}</h1>
            <p className="prep-sub mt-2">{t('prep.analyzing.sub')}</p>
          </div>
          <div className="prep-analyzing-steps">
            <span className="prep-analyzing-step">{t('prep.analyzing.step1')}</span>
            <span className="prep-analyzing-step">{t('prep.analyzing.step2')}</span>
            <span className="prep-analyzing-step">{t('prep.analyzing.step3')}</span>
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
        <p className="prep-sub mt-2 max-w-2xl">{t('prep.setup.sub')}</p>
      </header>

      <section className="prep-setup-shell">
        <div className="prep-setup-main">
          <div className="prep-field-heading">
            <span className="prep-field-heading__icon" aria-hidden="true">
              <BriefcaseBusiness size={18} />
            </span>
            <div>
              <label htmlFor="vacancy-text" className="prep-h2">
                {t('prep.vacancyLabel')}
              </label>
              <p className="prep-faint mt-0.5">{t('prep.setup.vacancyHint')}</p>
            </div>
          </div>

          <textarea
            id="vacancy-text"
            className="prep-textarea prep-vacancy-textarea mt-4"
            placeholder={t('prep.vacancyPlaceholder')}
            name="vacancyText"
            autoComplete="off"
            value={vacancyText}
            onChange={(event) => setVacancyText(event.target.value)}
            autoFocus
          />

          {error && (
            <p className="prep-inline-error mt-3" role="alert">
              {error}
            </p>
          )}

          <div className="prep-setup-submit">
            <p className="prep-faint">
              {canAnalyze ? t('prep.setup.ready') : t('prep.needText')}
            </p>
            <button type="button" className="prep-btn" disabled={!canAnalyze} onClick={submit}>
              {t('home.action.reviewVacancy')}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <aside className="prep-setup-aside" aria-label={t('prep.setup.contextTitle')}>
          <div>
            <p className="prep-eyebrow">{t('prep.setup.contextEyebrow')}</p>
            <h2 className="prep-h2 mt-1">{t('prep.setup.contextTitle')}</h2>
            <p className="prep-faint mt-1.5">{t('prep.setup.contextBody')}</p>
          </div>

          <SetupStatus
            icon={FileUser}
            title={t('docs.kind.resume')}
            detail={resumeReady ? t('prep.setup.connected') : t('prep.setup.notConnected')}
            ready={resumeReady}
          />
          <SetupStatus
            icon={FileText}
            title={t('docs.kind.legend')}
            detail={legendReady ? t('prep.setup.connected') : t('prep.setup.notConnected')}
            ready={legendReady}
          />

          <Link to="/documents" className="prep-link-btn">
            {t('prep.setup.openProfile')}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>

          <details className="prep-disclosure">
            <summary>
              <span>
                <Settings2 size={15} aria-hidden="true" />
                {t('prep.setup.options')}
              </span>
              <ChevronDown size={15} aria-hidden="true" />
            </summary>
            <div className="prep-disclosure__body">
              <label htmlFor="target-role" className="prep-faint">
                {t('prep.roleLabel')}
              </label>
              <input
                id="target-role"
                className="prep-input mt-1 w-full"
                placeholder={t('prep.rolePlaceholder')}
                name="targetRole"
                autoComplete="off"
                value={targetRole}
                onChange={(event) => setTargetRole(event.target.value)}
              />

              <fieldset className="mt-4">
                <legend className="prep-faint">{t('prep.answerLangLabel')}</legend>
                <div className="prep-segmented mt-1">
                  {(['ru', 'en'] as AnswerLanguage[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={language === option}
                      className={language === option ? 'is-active' : ''}
                      onClick={() => setLanguage(option)}
                    >
                      {option.toUpperCase()}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
          </details>

          <details className="prep-disclosure">
            <summary>
              <span>
                <FileText size={15} aria-hidden="true" />
                {t('prep.setup.overrideContext')}
              </span>
              <ChevronDown size={15} aria-hidden="true" />
            </summary>
            <div className="prep-disclosure__body space-y-4">
              <ContextEditor
                label={t('docs.kind.resume')}
                name="resumeContext"
                value={resumeText}
                placeholder={t('prep.resumePlaceholder')}
                docs={docs.filter((document) => document.kind === 'resume')}
                onChange={setResumeText}
                onPick={(id) => loadDoc(id, 'resume')}
              />
              <ContextEditor
                label={t('docs.kind.legend')}
                name="legendContext"
                value={legendText}
                placeholder={t('prep.legendPlaceholder')}
                docs={docs.filter((document) => document.kind === 'legend')}
                onChange={setLegendText}
                onPick={(id) => loadDoc(id, 'legend')}
              />
            </div>
          </details>
        </aside>
      </section>
    </div>
  );
}

function SetupStatus({
  icon: Icon,
  title,
  detail,
  ready,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  ready: boolean;
}) {
  return (
    <div className="prep-setup-status">
      <span className={`prep-setup-status__icon ${ready ? 'is-ready' : ''}`}>
        <Icon size={15} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      {ready && <Check size={15} aria-label={detail} />}
    </div>
  );
}

function ContextEditor({
  label,
  name,
  value,
  placeholder,
  docs,
  onChange,
  onPick,
}: {
  label: string;
  name: string;
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
            <button
              key={document.id}
              type="button"
              className="prep-chip prep-doc-chip"
              title={document.title}
              onClick={() => onPick(document.id)}
            >
              {document.title.slice(0, 22)}
            </button>
          ))}
        </div>
      )}
      <textarea
        className="prep-textarea mt-2"
        style={{ minHeight: 110 }}
        aria-label={label}
        name={name}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
