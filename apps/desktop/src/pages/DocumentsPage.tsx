import { useEffect, useRef, useState } from 'react';
import { api, DocumentItem } from '../lib/api';

const KINDS = [
  { value: 'resume', label: 'Резюме' },
  { value: 'vacancy', label: 'Вакансия' },
  { value: 'notes', label: 'Заметки' },
];

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

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h2 className="page-title">Документы</h2>
        <p className="page-subtitle">
          Резюме, вакансия и заметки — основа для ответов ассистента (RAG)
        </p>
      </div>

      <div className="card mb-6 space-y-4 p-5">
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
          rows={6}
          className="field resize-y leading-relaxed"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={addText} disabled={busy} className="btn-primary">
            Добавить текст
          </button>
          <span className="text-xs text-ink-faint">или загрузите файл</span>
          <label className="btn-secondary btn-sm cursor-pointer">
            Выбрать файл (PDF / DOCX / TXT)
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={onFile}
              className="hidden"
            />
          </label>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      <div className="space-y-2">
        {docs.length === 0 && (
          <div className="rounded-2xl border border-dashed border-surface-border py-10 text-center text-sm text-ink-faint">
            Документов пока нет
          </div>
        )}
        {docs.map((doc) => (
          <div
            key={doc.id}
            className="card card-hover flex items-center justify-between px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <span className="pill">{KINDS.find((k) => k.value === doc.kind)?.label ?? doc.kind}</span>
              <p className="text-sm text-ink">{doc.title}</p>
            </div>
            <button
              onClick={() => remove(doc.id)}
              className="rounded-lg px-2.5 py-1 text-xs text-ink-faint transition-colors hover:bg-red-950/40 hover:text-red-300"
            >
              Удалить
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
