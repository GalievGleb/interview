import { useCallback, useEffect, useMemo, useState } from 'react';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import { api, SessionItem, SessionDetail } from '../lib/api';
import { buildStoredSessionExport } from '../lib/interviewSessionExport';

export default function HistoryPage() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.listSessions();
      setSessions(res.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const open = async (id: string) => {
    try {
      const detail = await api.getSession(id);
      setSelected(detail);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Удалить сессию и все связанные ответы?')) return;

    setDeletingId(id);
    setError('');
    try {
      await api.deleteSession(id);
      setSessions((prev) => prev.filter((item) => item.id !== id));
      if (selected?.id === id) setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить сессию');
    } finally {
      setDeletingId(null);
    }
  };

  const exportData = useMemo(
    () => (selected ? buildStoredSessionExport(selected) : null),
    [selected],
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="page-title">История</h2>
          <p className="page-subtitle">Прошлые сессии, ответы и транскрипты</p>
        </div>
        {exportData && <InterviewExportButtons exportData={exportData} compact />}
      </div>

      <div className="flex gap-6">
        <div className="w-80 shrink-0">
          {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
          {loading && <p className="text-sm text-ink-faint">Загрузка…</p>}
          {!loading && sessions.length === 0 && (
            <div className="rounded-2xl border border-dashed border-surface-border py-10 text-center text-sm text-ink-faint">
              Сессий пока нет
            </div>
          )}
          <div className="space-y-1.5">
            {sessions.map((session) => (
              <div
                key={session.id}
                className={`rounded-xl border transition-colors ${
                  selected?.id === session.id
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-surface-border bg-surface-light hover:border-surface-border-strong hover:bg-surface-hover'
                }`}
              >
                <button
                  type="button"
                  onClick={() => open(session.id)}
                  className="block w-full px-3.5 py-2.5 text-left"
                >
                  <p className="truncate text-sm font-medium text-ink">
                    {session.title || session.mode}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {new Date(session.started_at).toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {session.answer_count ?? 0} answers · {session.transcript_count ?? 0} transcript lines
                  </p>
                </button>
                <div className="flex justify-end border-t border-surface-border/60 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => void remove(session.id)}
                    disabled={deletingId === session.id}
                    className="text-xs text-red-400 transition hover:text-red-300 disabled:opacity-50"
                  >
                    {deletingId === session.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1">
          {!selected && (
            <div className="rounded-2xl border border-dashed border-surface-border py-16 text-center text-sm text-ink-faint">
              Выберите сессию слева
            </div>
          )}
          {selected && (
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold tracking-tight text-ink">
                  {selected.title || selected.mode}
                </h3>
                <p className="text-xs text-ink-faint">
                  {selected.answers.length} answers · {selected.transcripts.length} transcript lines
                </p>
              </div>
              {selected.summary && (
                <div className="card mb-4 whitespace-pre-wrap p-4 text-sm leading-relaxed text-ink">
                  {selected.summary}
                </div>
              )}
              {selected.answers.length > 0 && (
                <div className="space-y-3">
                  {selected.answers.map((answer) => (
                    <div key={answer.id} className="card p-4">
                      <p className="mb-1.5 text-sm font-medium text-accent">{answer.question}</p>
                      <p className="whitespace-pre-wrap text-sm text-ink-muted">
                        {answer.spoken || answer.short}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {selected.transcripts.length > 0 && (
                <div className="mt-4 space-y-1 text-sm text-ink-muted">
                  {selected.transcripts.map((line, index) => (
                    <p key={index}>
                      <span className="text-ink-faint">{line.speaker}:</span> {line.text}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
