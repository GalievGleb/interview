import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, LoaderCircle, Mic, Square } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import GrowthProfileSetup from '../components/candidate/GrowthProfileSetup';
import { api, DocumentItem } from '../lib/api';
import { readGrowthProfile, type GrowthProfileSetup as GrowthProfileSetupValue } from '../lib/growthProfile';
import { useI18n, type I18nKey } from '../lib/i18n';
import { listSessions } from '../lib/vacancyReview/vacancyReviewStore';
import { useVoiceAnswer } from '../lib/vacancyReview/useVoiceAnswer';
import Modal from '../components/Modal';

const KINDS: Array<{ value: string; labelKey: I18nKey }> = [
  { value: 'resume', labelKey: 'docs.kind.resume' },
  { value: 'legend', labelKey: 'docs.kind.legend' },
  { value: 'vacancy', labelKey: 'docs.kind.vacancy' },
  { value: 'notes', labelKey: 'docs.kind.notes' },
];

const KIND_STYLE: Record<string, { labelKey: I18nKey; tone: string }> = {
  resume: { labelKey: 'docs.kind.resume', tone: 'prep-tone-green' },
  legend: { labelKey: 'docs.kind.legend', tone: 'prep-tone-violet' },
  vacancy: { labelKey: 'docs.kind.vacancy', tone: 'prep-tone-blue' },
  notes: { labelKey: 'docs.kind.notes', tone: '' },
};

function FileIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function ResumeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M8 12h8M8 16h5" />
    </svg>
  );
}

function LegendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  );
}

interface PillarProps {
  icon: React.ReactNode;
  variant: 'resume' | 'legend';
  title: string;
  connectedTitle: string;
  count: number;
  primary: boolean;
  onAdd: () => void;
}

function SourcePillar({ icon, variant, title, connectedTitle, count, primary, onAdd }: PillarProps) {
  const { t } = useI18n();
  const on = count > 0;
  const docWord = count === 1 ? t('docs.doc.one') : t('docs.doc.many');
  return (
    <div className={`prep-source-pillar ${on ? 'is-on' : ''}`}>
      <div className="prep-source-head">
        <span className="prep-source-icon">{icon}</span>
        <div className="min-w-0">
          <p className="prep-eyebrow">{variant === 'resume' ? t('docs.kind.resume') : t('docs.kind.legend')}</p>
          <h3 className="text-[15px] font-bold" style={{ color: 'var(--prep-ink)' }}>
            {on ? connectedTitle : title}
          </h3>
        </div>
        <span className={`prep-source-state ${on ? 'is-on' : ''}`}>
          <span className="prep-source-dot" />
          {on ? t('docs.pillar.connected') : t('docs.pillar.empty')}
        </span>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          className={`prep-btn prep-btn-sm ${primary ? '' : 'prep-btn-secondary'}`}
          onClick={onAdd}
        >
          {on
            ? t('docs.pillar.addMore')
            : variant === 'resume'
              ? t('docs.pillar.addResume')
              : t('docs.pillar.addLegend')}
        </button>
        {on && (
          <span className="prep-faint">
            <span className="prep-source-count">{count}</span> {docWord}
          </span>
        )}
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const baselineMode = params.get('mode') === 'baseline';
  const growthSection = params.get('section');
  const returnToPreparation = params.get('next') === 'prepare';
  const returnSessionId = params.get('session')?.trim() ?? '';
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [hhResumeCount, setHhResumeCount] = useState(0);
  const [kind, setKind] = useState('resume');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busyKind, setBusyKind] = useState<'text' | 'file' | null>(null);
  const [error, setError] = useState('');
  const [textError, setTextError] = useState('');
  const [savedKind, setSavedKind] = useState('');
  const [composerOpen, setComposerOpen] = useState(returnToPreparation);
  const [documentToDelete, setDocumentToDelete] = useState<DocumentItem | null>(null);
  const [growthProfile, setGrowthProfile] = useState(readGrowthProfile);
  const uploadInFlightRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const experienceVoice = useVoiceAnswer((transcript) => {
    setText((current) => [current.trim(), transcript].filter(Boolean).join('\n\n'));
    setTextError('');
  }, {
    language: 'ru',
    question: 'Расскажите о навыках и опыте, которые не вошли в резюме.',
    topicLabels: ['дополнительный опыт', 'обучение', 'проекты', 'предметная область'],
  });
  const experienceVoiceRecording = experienceVoice.recording;
  const stopExperienceVoice = experienceVoice.stop;

  useEffect(() => {
    if (kind !== 'legend' && experienceVoiceRecording) stopExperienceVoice();
  }, [experienceVoiceRecording, kind, stopExperienceVoice]);

  const load = async () => {
    try {
      const res = await api.listDocuments();
      setDocs(res.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('docs.loadError'));
    }
  };

  useEffect(() => {
    void load();
    void window.electronAPI?.hhAssistant?.getResumes()
      .then((resumes) => setHhResumeCount(resumes.length))
      .catch(() => setHhResumeCount(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusComposer = (into: string) => {
    setKind(into);
    setComposerOpen(true);
    requestAnimationFrame(() => {
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      composerRef.current?.focus();
    });
  };

  const addText = async () => {
    if (busyKind !== null || uploadInFlightRef.current) return;
    if (!text.trim()) {
      setTextError('Добавьте текст материала или выберите файл для загрузки.');
      composerRef.current?.focus();
      return;
    }
    uploadInFlightRef.current = true;
    setBusyKind('text');
    setError('');
    setTextError('');
    try {
      await api.uploadText(kind, title || t(KINDS.find((k) => k.value === kind)!.labelKey), text);
      setSavedKind(kind);
      setText('');
      setTitle('');
      await load();
      window.dispatchEvent(new Event('skillcue:candidate-sources-updated'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('docs.addTextError'));
    } finally {
      uploadInFlightRef.current = false;
      setBusyKind(null);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (busyKind !== null || uploadInFlightRef.current) return;
    const file = e.target.files?.[0];
    if (!file) return;
    uploadInFlightRef.current = true;
    setBusyKind('file');
    setError('');
    try {
      await api.uploadFile(kind, file, file.name);
      setSavedKind(kind);
      await load();
      window.dispatchEvent(new Event('skillcue:candidate-sources-updated'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('docs.uploadError'));
    } finally {
      uploadInFlightRef.current = false;
      setBusyKind(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (id: string) => {
    await api.deleteDocument(id);
    await load();
    setDocumentToDelete(null);
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const d of docs) map[d.kind] = (map[d.kind] ?? 0) + 1;
    return map;
  }, [docs]);

  const sessions = listSessions();
  const embeddedResumeFallback = (counts.resume ?? 0) === 0
    && hhResumeCount === 0
    && sessions.some((session) => session.vacancyAnalysis.hasResume) ? 1 : 0;
  const resumeSourceCount = (counts.resume ?? 0) + hhResumeCount + embeddedResumeFallback;
  const hasResumeSource = resumeSourceCount > 0;
  const returnSession = returnSessionId
    ? sessions.find((session) => session.id === returnSessionId)
    : undefined;
  const nextAfterResume = returnToPreparation
    ? {
        title: 'Резюме добавлено — теперь сопоставьте его с вакансией.',
        label: 'Вернуться к разбору',
        to: '/prepare',
      }
    : { title: 'Резюме добавлено — выберите роль для практики.', label: 'Выбрать роль', to: '/documents?mode=baseline&section=role' };

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise prep-home">
        <section>
          <p className="prep-eyebrow">{baselineMode ? 'ПРОФИЛЬ' : t('docs.eyebrow')}</p>
          <h1 className="prep-h1 mt-1">
            {baselineMode ? 'Резюме и опыт' : t('docs.title')}
          </h1>
        </section>

        {savedKind === 'resume' && (
          <section className="candidate-next-step" role="status" aria-live="polite">
            <CheckCircle2 size={21} aria-hidden="true" />
            <div>
              <strong>{nextAfterResume.title}</strong>
              <p>SkillCue сохранит резюме как источник фактов и будет связывать следующие результаты с вашим опытом.</p>
            </div>
            <button type="button" className="prep-btn" onClick={() => {
              if (returnSession) {
                try {
                  sessionStorage.setItem('skillcue.prepare.draft.v1', JSON.stringify({
                    vacancyUrl: returnSession.vacancyAnalysis.vacancyUrl ?? '',
                    vacancyText: returnSession.vacancyAnalysis.vacancyText,
                    targetRole: returnSession.vacancyAnalysis.targetRole,
                    language: returnSession.vacancyAnalysis.language,
                  }));
                } catch { /* noop */ }
              }
              navigate(nextAfterResume.to);
            }}>
              {nextAfterResume.label} <ArrowRight size={15} aria-hidden="true" />
            </button>
          </section>
        )}

        <section className="prep-source-grid mt-5">
          <SourcePillar
            icon={<ResumeIcon />}
            variant="resume"
            title={t('docs.pillar.resumeOff')}
            connectedTitle={t('docs.pillar.resumeOn')}
            count={resumeSourceCount}
            primary={!hasResumeSource}
            onAdd={() => focusComposer('resume')}
          />
          <SourcePillar
            icon={<LegendIcon />}
            variant="legend"
            title={t('docs.pillar.legendOff')}
            connectedTitle={t('docs.pillar.legendOn')}
            count={counts.legend ?? 0}
            primary={hasResumeSource && (counts.legend ?? 0) === 0}
            onAdd={() => focusComposer('legend')}
          />
        </section>

        {!returnToPreparation && (
          <GrowthProfileSetup
            initialOpen={growthSection === 'role' || growthSection === 'goal' || growthSection === 'baseline' || (baselineMode && hasResumeSource && !growthProfile.completed)}
            onSaved={(next: GrowthProfileSetupValue) => setGrowthProfile(next)}
          />
        )}

        {!returnToPreparation && baselineMode && growthProfile.completed && (
          <section className="candidate-next-step" aria-labelledby="profile-next-step-title">
            <CheckCircle2 size={21} aria-hidden="true" />
            <div>
              <strong id="profile-next-step-title">Контекст готов.</strong>
              <p>Тренируйтесь по роли или разберите конкретную вакансию.</p>
            </div>
            <div className="candidate-journey-actions">
              <button type="button" className="prep-btn" onClick={() => navigate('/practice')}>
                Начать практику <ArrowRight size={15} aria-hidden="true" />
              </button>
              <button type="button" className="prep-btn prep-btn-ghost" onClick={() => navigate('/prepare')}>
                Добавить вакансию
              </button>
            </div>
          </section>
        )}

        {composerOpen && <section className="prep-doc-grid mt-5" aria-labelledby="document-composer-title">
          <form
            className="prep-action-card"
            onSubmit={(event) => { event.preventDefault(); void addText(); }}
            onKeyDown={(event) => {
              if (event.ctrlKey && event.key === 'Enter') {
                event.preventDefault();
                void addText();
              }
            }}
          >
            <p className="prep-eyebrow">{t('docs.add.eyebrow')}</p>
            <div className="prep-section-head">
              <h2 id="document-composer-title" className="prep-h2 prep-card-title">{t('docs.add.title')}</h2>
              <button type="button" className="prep-btn prep-btn-ghost prep-btn-sm" onClick={() => setComposerOpen(false)}>Закрыть</button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr]">
              <label className="prep-field-label" htmlFor="document-kind">
                <span>Тип материала</span>
                <select
                  id="document-kind"
                  value={kind}
                  onChange={(e) => { setKind(e.target.value); setSavedKind(''); }}
                  className="prep-input"
                  disabled={busyKind !== null}
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {t(k.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="prep-field-label" htmlFor="document-title">
                <span>Название</span>
                <input
                  id="document-title"
                  placeholder={t('docs.add.titlePlaceholder')}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="prep-input"
                  disabled={busyKind !== null}
                />
              </label>
            </div>
            <label className="prep-field-label mt-3" htmlFor="document-text">
              <span>{kind === 'legend' ? 'История опыта' : 'Текст материала'}</span>
              <textarea
                id="document-text"
                ref={composerRef}
                placeholder={kind === 'legend'
                  ? 'Например: в Школе 21 изучал C и решал учебные задачи; работал составителем поездов…'
                  : t('docs.add.textPlaceholder')}
                value={text}
                onChange={(e) => { setText(e.target.value); if (e.target.value.trim()) setTextError(''); }}
                rows={7}
                className="prep-textarea"
                disabled={busyKind !== null}
                aria-invalid={Boolean(textError)}
                aria-describedby={textError ? 'document-text-error' : undefined}
              />
            </label>
            {textError && <p id="document-text-error" className="prep-inline-error mt-2" role="alert">{textError}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {kind === 'legend' && (
                <button
                  type="button"
                  className={`prep-btn prep-btn-secondary ${experienceVoice.recording ? 'is-recording' : ''}`}
                  disabled={busyKind !== null || experienceVoice.finalizing}
                  aria-pressed={experienceVoice.recording}
                  onClick={() => void (experienceVoice.recording ? experienceVoice.finish() : experienceVoice.start())}
                >
                  {experienceVoice.finalizing
                    ? <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                    : experienceVoice.recording
                      ? <Square size={14} aria-hidden="true" />
                      : <Mic size={15} aria-hidden="true" />}
                  {experienceVoice.finalizing ? 'Распознаю…' : experienceVoice.recording ? 'Закончить запись' : 'Надиктовать опыт'}
                </button>
              )}
              <button
                type="submit"
                disabled={busyKind !== null}
                className="prep-btn"
              >
                {t('docs.add.addText')}
              </button>
              <button
                type="button"
                className="prep-btn prep-btn-secondary"
                disabled={busyKind !== null}
                onClick={() => fileRef.current?.click()}
              >
                {t('docs.add.uploadFile')}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt"
                onChange={onFile}
                className="hidden"
                disabled={busyKind !== null}
                tabIndex={-1}
              />
              <span className="prep-faint">PDF, DOCX, TXT</span>
              {busyKind && (
                <span className="prep-upload-progress" role="status" aria-live="polite">
                  <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                  {kind === 'resume'
                    ? t('docs.add.addingResume')
                    : t('docs.add.addingContext')}
                </span>
              )}
            </div>
            {kind === 'legend' && experienceVoice.recording && (
              <p className="prep-faint mt-2" role="status">Говорите — запись добавится в поле выше.</p>
            )}
            {kind === 'legend' && experienceVoice.error && (
              <p className="prep-inline-error mt-2" role="alert">{experienceVoice.error}</p>
            )}
            {error && (
              <p className="mt-3 text-[13px]" style={{ color: 'var(--prep-red)' }} role="alert">
                {error}
              </p>
            )}
          </form>

        </section>}

        {docs.length > 0 && <details className="prep-disclosure docs-library-disclosure">
          <summary>
            <span>{t('docs.library.title')} · {docs.length}</span>
            <span className="prep-faint">Показать</span>
          </summary>
          <div className="prep-disclosure__body prep-doc-list">
            {docs.map((doc) => {
              const style = KIND_STYLE[doc.kind];
              const label = style ? t(style.labelKey) : doc.kind.toUpperCase();
              return (
                <div key={doc.id} className="prep-doc-row">
                  <span className={`prep-doc-icon ${style?.tone ?? ''}`}>
                    <FileIcon />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold" style={{ color: 'var(--prep-ink)' }}>
                      {doc.title}
                    </p>
                    <span className={`prep-chip mt-1 ${style?.tone ?? ''}`}>{label}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDocumentToDelete(doc)}
                    className="prep-btn prep-btn-ghost prep-btn-sm shrink-0"
                  >
                    {t('common.delete')}
                  </button>
                </div>
              );
            })}
          </div>
        </details>}
      </div>
      <Modal
        open={Boolean(documentToDelete)}
        onClose={() => setDocumentToDelete(null)}
        title="Удалить материал?"
        subtitle={documentToDelete?.title}
        footer={(
          <>
            <button type="button" className="btn-secondary" onClick={() => setDocumentToDelete(null)}>Отмена</button>
            <button type="button" className="btn-danger" onClick={() => documentToDelete && void remove(documentToDelete.id)}>Удалить</button>
          </>
        )}
      >
        <p className="text-sm text-ink-muted">Материал перестанет использоваться в ответах и подготовке.</p>
      </Modal>
    </div>
  );
}
