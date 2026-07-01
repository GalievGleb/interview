import { useEffect, useMemo, useRef, useState } from 'react';
import { api, DocumentItem } from '../lib/api';

const KINDS = [
  { value: 'resume', label: 'Резюме' },
  { value: 'legend', label: 'Легенда' },
  { value: 'vacancy', label: 'Вакансия' },
  { value: 'notes', label: 'Заметки' },
];

const KIND_STYLE: Record<string, { label: string; tone: string }> = {
  resume: { label: 'Resume', tone: 'prep-tone-green' },
  legend: { label: 'Legend', tone: 'prep-tone-violet' },
  vacancy: { label: 'Vacancy', tone: 'prep-tone-blue' },
  notes: { label: 'Notes', tone: '' },
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
  label: string;
  title: string;
  connectedTitle: string;
  count: number;
  onAdd: () => void;
}

function SourcePillar({ icon, label, title, connectedTitle, count, onAdd }: PillarProps) {
  const on = count > 0;
  return (
    <div className={`prep-source-pillar ${on ? 'is-on' : ''}`}>
      <div className="prep-source-head">
        <span className="prep-source-icon">{icon}</span>
        <div className="min-w-0">
          <p className="prep-eyebrow">{label}</p>
          <h3 className="text-[15px] font-bold" style={{ color: 'var(--prep-ink)' }}>
            {on ? connectedTitle : title}
          </h3>
        </div>
        <span className={`prep-source-state ${on ? 'is-on' : ''}`}>
          <span className="prep-source-dot" />
          {on ? 'Подключено' : 'Пусто'}
        </span>
      </div>
      <p className="prep-sub mt-3 flex-1">
        {label === 'Resume' ? (
          <>Реальные факты: роли, стек, проекты. Live-ответы держатся в этих рамках.</>
        ) : (
          <>Позиционирование и формулировки для спорных мест — чтобы ответы звучали уверенно и связно.</>
        )}
      </p>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="prep-btn prep-btn-sm" onClick={onAdd}>
          {on ? 'Добавить ещё' : `Добавить ${label === 'Resume' ? 'резюме' : 'легенду'}`}
        </button>
        {on && (
          <span className="prep-faint">
            <span className="prep-source-count">{count}</span> {count === 1 ? 'документ' : 'документа'}
          </span>
        )}
      </div>
    </div>
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
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const load = async () => {
    try {
      const res = await api.listDocuments();
      setDocs(res.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки документов');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const focusComposer = (into: string) => {
    setKind(into);
    requestAnimationFrame(() => {
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      composerRef.current?.focus();
    });
  };

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
      setError(err instanceof Error ? err.message : 'Не удалось добавить текст');
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
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setBusy(false);
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
          <p className="prep-eyebrow">Answer source</p>
          <h1 className="prep-h1 mt-1">Откуда SkillCue берёт ответы.</h1>
          <p className="prep-sub mt-1.5 max-w-2xl">
            Live-подсказки грунтуются на двух вещах: реальном резюме и вашей легенде опыта.
            Чем точнее источник, тем меньше общего AI-текста и больше ответов «от себя».
          </p>
        </section>

        <section className="prep-source-grid mt-5">
          <SourcePillar
            icon={<ResumeIcon />}
            label="Resume"
            title="Резюме не подключено"
            connectedTitle="Резюме подключено"
            count={counts.resume ?? 0}
            onAdd={() => focusComposer('resume')}
          />
          <SourcePillar
            icon={<LegendIcon />}
            label="Legend"
            title="Легенда не подключена"
            connectedTitle="Легенда подключена"
            count={counts.legend ?? 0}
            onAdd={() => focusComposer('legend')}
          />
        </section>

        <section className="prep-doc-grid mt-5">
          <div className="prep-action-card">
            <p className="prep-eyebrow">Add context</p>
            <h2 className="prep-h2 prep-card-title">Вставьте резюме, легенду или заметки.</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr]">
              <select value={kind} onChange={(e) => setKind(e.target.value)} className="prep-input">
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <input
                placeholder="Название, например: QA Automation resume"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="prep-input"
              />
            </div>
            <textarea
              ref={composerRef}
              placeholder="Вставьте текст резюме, легенды или заметок..."
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              className="prep-textarea mt-3"
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button onClick={addText} disabled={busy || !text.trim()} className="prep-btn">
                {busy ? 'Добавляю...' : 'Добавить текст'}
              </button>
              <label className="prep-btn prep-btn-secondary cursor-pointer">
                Загрузить файл
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.docx,.txt"
                  onChange={onFile}
                  className="hidden"
                />
              </label>
              <span className="prep-faint">PDF, DOCX, TXT</span>
            </div>
            {error && (
              <p className="mt-3 text-[13px]" style={{ color: 'var(--prep-red)' }}>
                {error}
              </p>
            )}
          </div>

          <div className="prep-next-card">
            <p className="prep-eyebrow">В live SkillCue использует</p>
            <h2 className="prep-h2 prep-card-title">
              {grounded ? 'Ваш контекст, а не общий AI.' : 'Пока только общий AI.'}
            </h2>
            <div className="prep-rule-list mt-4">
              <span>Инструменты и стек из резюме</span>
              <span>Проекты и зона ответственности</span>
              <span>Легенда: где формулировать аккуратно</span>
            </div>
          </div>
        </section>

        <section>
          <div className="prep-section-head">
            <div>
              <p className="prep-eyebrow">Library</p>
              <h2 className="prep-h2 prep-section-title">Подключённые материалы</h2>
            </div>
            {docs.length > 0 && <span className="prep-faint">{docs.length} всего</span>}
          </div>

          <div className="prep-doc-list">
            {docs.length === 0 && (
              <div className="prep-empty-state">
                <p className="prep-h2">Источников пока нет</p>
                <p className="prep-sub mt-1">
                  Добавьте резюме или легенду, чтобы live-ответы перестали быть общими.
                </p>
              </div>
            )}
            {docs.map((doc) => {
              const style = KIND_STYLE[doc.kind] ?? { label: doc.kind.toUpperCase(), tone: '' };
              return (
                <div key={doc.id} className="prep-doc-row">
                  <span className={`prep-doc-icon ${style.tone}`}>
                    <FileIcon />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold" style={{ color: 'var(--prep-ink)' }}>
                      {doc.title}
                    </p>
                    <span className={`prep-chip mt-1 ${style.tone}`}>{style.label}</span>
                  </div>
                  <button
                    onClick={() => void remove(doc.id)}
                    className="prep-btn prep-btn-ghost prep-btn-sm shrink-0"
                  >
                    Удалить
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
