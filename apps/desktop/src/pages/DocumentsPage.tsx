import { useEffect, useMemo, useRef, useState } from 'react';
import { api, DocumentItem } from '../lib/api';
import ScreenHeader from '../components/ScreenHeader';

const KINDS = [
  { value: 'resume', label: 'Резюме' },
  { value: 'vacancy', label: 'Вакансия' },
  { value: 'notes', label: 'Заметки' },
];

const KIND_STYLE: Record<string, { label: string; tile: string }> = {
  resume: { label: 'RESUME', tile: 'bg-accent-soft text-accent' },
  vacancy: { label: 'VACANCY', tile: 'bg-emerald-500/15 text-emerald-400' },
  notes: { label: 'NOTES', tile: 'bg-sky-500/15 text-sky-400' },
};

function FileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [kind, setKind] = useState('resume');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await api.listDocuments();
      setDocs(res.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const addText = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.uploadText(kind, title || KINDS.find((k) => k.value === kind)!.label, text);
      setText('');
      setTitle('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      await api.uploadFile(kind, file, file.name);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (id: string) => {
    await api.deleteDocument(id);
    await load();
  };

  const kindsInUse = useMemo(() => {
    const set = new Set(docs.map((d) => d.kind));
    return [...set];
  }, [docs]);

  return (
    <div>
      <ScreenHeader
        title="Documents & context"
        subtitle="Resume and notes SkillCue uses to tailor answers to you."
        actions={
          <label className="btn-primary btn-sm cursor-pointer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add file
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={onFile}
              className="hidden"
            />
          </label>
        }
      />

      <div className="max-w-3xl space-y-5">
        {/* Active context */}
        <div className="sc-card border-accent/25 bg-accent/[0.05] p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
              </svg>
            </span>
            <div>
              <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                Active context
                <span className="sc-badge sc-badge--accent">{docs.length} files in use</span>
              </p>
            </div>
          </div>
          <p className="mb-2 text-sm text-ink-muted">Answers are tailored to:</p>
          <div className="flex flex-wrap gap-2">
            {kindsInUse.length === 0 && (
              <span className="text-sm text-ink-faint">No documents yet — add your resume to start.</span>
            )}
            {kindsInUse.map((k) => (
              <span key={k} className="sc-ctx-chip">
                {KINDS.find((x) => x.value === k)?.label ?? k}
              </span>
            ))}
          </div>
        </div>

        {/* Add context */}
        <div className="sc-card p-5">
          <p className="mb-3 text-sm font-semibold text-ink">Add context</p>
          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row">
              <select value={kind} onChange={(e) => setKind(e.target.value)} className="field sm:max-w-[180px]">
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <input
                placeholder="Заголовок (необязательно)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="field flex-1"
              />
            </div>
            <textarea
              placeholder="Вставьте текст резюме / вакансии / заметок..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              className="field resize-y leading-relaxed"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={addText} disabled={busy} className="btn-primary btn-sm">
                Добавить текст
              </button>
              <span className="text-xs text-ink-faint">или используйте «Add file» выше (PDF / DOCX / TXT)</span>
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        </div>

        {/* Context files */}
        <div>
          <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Context files
          </p>
          <div className="space-y-2">
            {docs.length === 0 && (
              <div className="sc-empty rounded-2xl border border-dashed border-surface-border">
                Документов пока нет
              </div>
            )}
            {docs.map((doc) => {
              const style = KIND_STYLE[doc.kind] ?? { label: doc.kind.toUpperCase(), tile: 'bg-surface-elevated text-ink-faint' };
              return (
                <div key={doc.id} className="sc-card flex items-center gap-3 px-4 py-3">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${style.tile}`}>
                    <FileIcon />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-semibold text-ink">{doc.title}</span>
                      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                        {style.label}
                      </span>
                    </p>
                  </div>
                  <button
                    onClick={() => remove(doc.id)}
                    className="shrink-0 rounded-lg px-2.5 py-1 text-xs text-ink-faint transition-colors hover:bg-red-950/40 hover:text-red-300"
                  >
                    Удалить
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Privacy */}
        <div className="cockpit-alert cockpit-alert-info">
          <span>Документы хранятся локально и не загружаются в облако в локальном режиме.</span>
        </div>
      </div>
    </div>
  );
}
