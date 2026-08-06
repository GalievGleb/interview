import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api, DocumentItem } from '../lib/api';
import { useI18n, type I18nKey } from '../lib/i18n';

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
  onAdd: () => void;
}

function SourcePillar({ icon, variant, title, connectedTitle, count, onAdd }: PillarProps) {
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
      <p className="prep-sub mt-3 flex-1">
        {variant === 'resume' ? t('docs.pillar.resumeDesc') : t('docs.pillar.legendDesc')}
      </p>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="prep-btn prep-btn-sm" onClick={onAdd}>
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
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [kind, setKind] = useState('resume');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busyKind, setBusyKind] = useState<'text' | 'file' | null>(null);
  const [error, setError] = useState('');
  const uploadInFlightRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusComposer = (into: string) => {
    setKind(into);
    requestAnimationFrame(() => {
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      composerRef.current?.focus();
    });
  };

  const addText = async () => {
    if (busyKind !== null || uploadInFlightRef.current || !text.trim()) return;
    uploadInFlightRef.current = true;
    setBusyKind('text');
    setError('');
    try {
      await api.uploadText(kind, title || t(KINDS.find((k) => k.value === kind)!.labelKey), text);
      setText('');
      setTitle('');
      await load();
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
      await load();
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
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const d of docs) map[d.kind] = (map[d.kind] ?? 0) + 1;
    return map;
  }, [docs]);

  const grounded = (counts.resume ?? 0) > 0 || (counts.legend ?? 0) > 0;

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise prep-home">
        <section>
          <p className="prep-eyebrow">{t('docs.eyebrow')}</p>
          <h1 className="prep-h1 mt-1">{t('docs.title')}</h1>
          <p className="prep-sub mt-1.5 max-w-2xl">{t('docs.sub')}</p>
        </section>

        <section className="prep-source-grid mt-5">
          <SourcePillar
            icon={<ResumeIcon />}
            variant="resume"
            title={t('docs.pillar.resumeOff')}
            connectedTitle={t('docs.pillar.resumeOn')}
            count={counts.resume ?? 0}
            onAdd={() => focusComposer('resume')}
          />
          <SourcePillar
            icon={<LegendIcon />}
            variant="legend"
            title={t('docs.pillar.legendOff')}
            connectedTitle={t('docs.pillar.legendOn')}
            count={counts.legend ?? 0}
            onAdd={() => focusComposer('legend')}
          />
        </section>

        <section className="prep-doc-grid mt-5">
          <div className="prep-action-card">
            <p className="prep-eyebrow">{t('docs.add.eyebrow')}</p>
            <h2 className="prep-h2 prep-card-title">{t('docs.add.title')}</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr]">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="prep-input"
                disabled={busyKind !== null}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {t(k.labelKey)}
                  </option>
                ))}
              </select>
              <input
                placeholder={t('docs.add.titlePlaceholder')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="prep-input"
                disabled={busyKind !== null}
              />
            </div>
            <textarea
              ref={composerRef}
              placeholder={t('docs.add.textPlaceholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              className="prep-textarea mt-3"
              disabled={busyKind !== null}
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={addText}
                disabled={busyKind !== null || !text.trim()}
                className="prep-btn"
              >
                {t('docs.add.addText')}
              </button>
              <label
                className={`prep-btn prep-btn-secondary ${
                  busyKind !== null ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                }`}
                aria-disabled={busyKind !== null ? 'true' : undefined}
              >
                {t('docs.add.uploadFile')}
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.docx,.txt"
                  onChange={onFile}
                  className="hidden"
                  disabled={busyKind !== null}
                />
              </label>
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
            {error && (
              <p className="mt-3 text-[13px]" style={{ color: 'var(--prep-red)' }}>
                {error}
              </p>
            )}
          </div>

          <div className="prep-next-card">
            <p className="prep-eyebrow">{t('docs.uses.eyebrow')}</p>
            <h2 className="prep-h2 prep-card-title">
              {grounded ? t('docs.uses.grounded') : t('docs.uses.generic')}
            </h2>
            <div className="prep-rule-list mt-4">
              <span>{t('docs.uses.rule1')}</span>
              <span>{t('docs.uses.rule2')}</span>
              <span>{t('docs.uses.rule3')}</span>
            </div>
          </div>
        </section>

        <section>
          <div className="prep-section-head">
            <div>
              <p className="prep-eyebrow">{t('docs.library.eyebrow')}</p>
              <h2 className="prep-h2 prep-section-title">{t('docs.library.title')}</h2>
            </div>
            {docs.length > 0 && <span className="prep-faint">{docs.length} {t('home.analytics.total')}</span>}
          </div>

          <div className="prep-doc-list">
            {docs.length === 0 && (
              <div className="prep-empty-state">
                <p className="prep-h2">{t('docs.empty.title')}</p>
                <p className="prep-sub mt-1">{t('docs.empty.sub')}</p>
              </div>
            )}
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
                    onClick={() => void remove(doc.id)}
                    className="prep-btn prep-btn-ghost prep-btn-sm shrink-0"
                  >
                    {t('common.delete')}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
