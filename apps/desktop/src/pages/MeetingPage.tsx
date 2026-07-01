import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';
import MarkdownText from '../components/MarkdownText';

type Mode = 'review' | 'summary';

export default function MeetingPage() {
  const { hasAnyKey } = useApp();
  const [transcript, setTranscript] = useState('');
  const [result, setResult] = useState('');
  const [mode, setMode] = useState<Mode>('review');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [localLlm, setLocalLlm] = useState(false);
  const [localModel, setLocalModel] = useState('llama3.1');
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelRef.current?.(), []);

  const readFile = async (file: File) => {
    try {
      const text = await file.text();
      setTranscript(text);
      setFileName(file.name);
      setError('');
    } catch {
      setError('Не удалось прочитать файл');
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void readFile(file);
  };

  const run = () => {
    if (!transcript.trim() || loading) return;
    setLoading(true);
    setError('');
    setResult('');
    // Both modes stream token-by-token for instant feedback.
    const stream = mode === 'review' ? api.streamInterviewReview : api.streamMeetingSummary;
    const opts = localLlm ? { provider: 'ollama', model: localModel.trim() || 'llama3.1' } : {};
    cancelRef.current = stream(
      transcript,
      {
        onChunk: (t) => setResult((prev) => prev + t),
        onDone: () => setLoading(false),
        onError: (m) => {
          setError(m);
          setLoading(false);
        },
      },
      opts,
    );
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <h2 className="page-title">Разбор разговора</h2>
        <p className="page-subtitle">
          Загрузите запись интервью (или вставьте текст) — получите разбор слабых ответов
          кандидата либо summary встречи. Аудио не загружается; анализируется только текст.
        </p>
      </div>

      {!hasAnyKey && !localLlm && (
        <div className="mb-4 rounded-xl border border-amber-700/30 bg-amber-950/20 p-3.5 text-sm text-amber-200">
          Сначала добавьте API-ключ в «Настройках» — или включите локальную модель ниже.
        </div>
      )}

      {/* Local LLM (Ollama) — privacy + zero cost, off the live path */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={localLlm}
            onChange={(e) => setLocalLlm(e.target.checked)}
            className="h-4 w-4 accent-[#34c77b]"
          />
          Локально (Ollama)
        </label>
        {localLlm && (
          <>
            <input
              value={localModel}
              onChange={(e) => setLocalModel(e.target.value)}
              placeholder="модель (например llama3.1)"
              className="field max-w-[220px] py-1.5 text-xs"
            />
            <span className="text-xs text-ink-faint">
              Нужен запущенный Ollama (localhost:11434). Анализ не уходит в облако.
            </span>
          </>
        )}
      </div>

      <div className="segmented mb-3" role="group" aria-label="Режим анализа">
        <button
          type="button"
          onClick={() => setMode('review')}
          className={`segmented-item ${mode === 'review' ? 'segmented-item-active' : ''}`}
        >
          Разбор интервью
        </button>
        <button
          type="button"
          onClick={() => setMode('summary')}
          className={`segmented-item ${mode === 'summary' ? 'segmented-item-active' : ''}`}
        >
          Summary встречи
        </button>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`mb-3 cursor-pointer rounded-xl border border-dashed p-4 text-center text-sm transition-colors ${
          dragOver
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-surface-border text-ink-muted hover:border-surface-border-strong'
        }`}
      >
        {fileName
          ? `Загружен: ${fileName} — кликните, чтобы заменить`
          : 'Перетащите файл с разговором (.txt, .md, .vtt, .srt) или кликните для выбора'}
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.vtt,.srt,.json,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f);
          }}
        />
      </div>

      <textarea
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
        placeholder="…или вставьте текст разговора сюда"
        rows={10}
        className="field resize-y leading-relaxed"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => void run()}
          disabled={loading || !transcript.trim()}
          className="btn-primary"
        >
          {loading ? 'Анализ…' : mode === 'review' ? 'Разобрать интервью' : 'Сделать summary'}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {result && (
        <div className="card mt-6 p-5 text-sm leading-relaxed text-ink">
          <MarkdownText text={result} />
        </div>
      )}
    </div>
  );
}
