import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';
import { useI18n } from '../lib/i18n';
import MarkdownText from '../components/MarkdownText';

type Mode = 'review' | 'summary';

export default function MeetingPage() {
  const { t } = useI18n();
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
  const [savedToHistory, setSavedToHistory] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelRef.current?.(), []);

  // Сохраняем готовый разбор в Историю (mode=meeting), чтобы он не терялся
  // после закрытия страницы: summary + исходный транскрипт.
  const saveToHistory = async (summary: string, sourceTranscript: string, kind: Mode) => {
    try {
      const title = `${kind === 'review' ? t('meeting.reviewTitle') : t('meeting.summaryTitle')}${
        fileName ? ` — ${fileName}` : ''
      }`;
      const session = await api.createSession('meeting', title);
      await api
        .addTranscript(session.id, 'other', sourceTranscript.slice(0, 20000))
        .catch(() => undefined);
      await api.endSession(session.id, summary);
      setSavedToHistory(true);
    } catch {
      /* non-fatal: результат остаётся на экране */
    }
  };

  const readFile = async (file: File) => {
    try {
      const text = await file.text();
      setTranscript(text);
      setFileName(file.name);
      setError('');
    } catch {
      setError(t('meeting.readError'));
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
    setSavedToHistory(false);
    // Both modes stream token-by-token for instant feedback.
    const stream = mode === 'review' ? api.streamInterviewReview : api.streamMeetingSummary;
    const opts = localLlm ? { provider: 'ollama', model: localModel.trim() || 'llama3.1' } : {};
    const sourceTranscript = transcript;
    const kind = mode;
    let accumulated = '';
    cancelRef.current = stream(
      transcript,
      {
        onChunk: (chunk) => {
          accumulated += chunk;
          setResult((prev) => prev + chunk);
        },
        onDone: () => {
          setLoading(false);
          if (accumulated.trim()) void saveToHistory(accumulated.trim(), sourceTranscript, kind);
        },
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
        <h2 className="page-title">{t('settings.dev.meeting')}</h2>
        <p className="page-subtitle">{t('meeting.pageSub')}</p>
      </div>

      {!hasAnyKey && !localLlm && (
        <div className="mb-4 rounded-xl border border-amber-700/30 bg-amber-950/20 p-3.5 text-sm text-amber-200">
          {t('meeting.needKey')}
        </div>
      )}

      {/* Local LLM (Ollama) — privacy + zero cost, off the live path */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={localLlm}
            onChange={(e) => setLocalLlm(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {t('meeting.local')}
        </label>
        {localLlm && (
          <>
            <input
              value={localModel}
              onChange={(e) => setLocalModel(e.target.value)}
              placeholder={t('meeting.modelPlaceholder')}
              className="field max-w-[220px] py-1.5 text-xs"
            />
            <span className="text-xs text-ink-faint">{t('meeting.localHint')}</span>
          </>
        )}
      </div>

      <div className="segmented mb-3" role="group" aria-label={t('meeting.modeAria')}>
        <button
          type="button"
          onClick={() => setMode('review')}
          className={`segmented-item ${mode === 'review' ? 'segmented-item-active' : ''}`}
        >
          {t('meeting.reviewTitle')}
        </button>
        <button
          type="button"
          onClick={() => setMode('summary')}
          className={`segmented-item ${mode === 'summary' ? 'segmented-item-active' : ''}`}
        >
          {t('meeting.summaryTitle')}
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
          ? `${t('meeting.loaded')} ${fileName} ${t('meeting.replaceHint')}`
          : t('meeting.dropHint')}
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
        placeholder={t('meeting.pasteHint')}
        rows={10}
        className="field resize-y leading-relaxed"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => void run()}
          disabled={loading || !transcript.trim()}
          className="btn-primary"
        >
          {loading ? t('meeting.analyzing') : mode === 'review' ? t('meeting.reviewBtn') : t('meeting.summaryBtn')}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {result && (
        <div className="card mt-6 p-5 text-sm leading-relaxed text-ink">
          {savedToHistory && (
            <p className="mb-3 text-xs text-emerald-400">{t('meeting.savedToHistory')}</p>
          )}
          <MarkdownText text={result} />
        </div>
      )}
    </div>
  );
}
