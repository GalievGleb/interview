import { useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';

export default function MeetingPage() {
  const { hasAnyKey } = useApp();
  const [transcript, setTranscript] = useState('');
  const [summary, setSummary] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const summarize = async () => {
    if (!transcript.trim()) return;
    setLoading(true);
    setError('');
    setSummary('');
    try {
      const res = await api.meetingSummary(transcript);
      setSummary(res.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <h2 className="page-title">Meeting Copilot</h2>
        <p className="page-subtitle">
          Вставьте транскрипт встречи — получите summary, решения и action items.
          Live-транскрипция (Deepgram) появится в следующем этапе.
        </p>
      </div>

      {!hasAnyKey && (
        <div className="mb-4 rounded-xl border border-amber-700/30 bg-amber-950/20 p-3.5 text-sm text-amber-200">
          Сначала добавьте API-ключ в «Настройках».
        </div>
      )}

      <textarea
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
        placeholder="Вставьте текст встречи..."
        rows={10}
        className="field resize-y leading-relaxed"
      />
      <div className="mt-3 flex items-center gap-3">
        <button onClick={summarize} disabled={loading} className="btn-primary">
          {loading ? 'Анализ...' : 'Сделать summary'}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {summary && (
        <div className="card mt-6 whitespace-pre-wrap p-5 text-sm leading-relaxed text-ink">
          {summary}
        </div>
      )}
    </div>
  );
}
