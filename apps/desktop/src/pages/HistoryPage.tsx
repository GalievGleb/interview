import { useEffect, useMemo, useState } from 'react';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import { api, SessionItem, SessionDetail } from '../lib/api';
import { buildStoredSessionExport } from '../lib/interviewSessionExport';

export default function HistoryPage() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.listSessions();
        setSessions(res.sessions);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка');
      }
    })();
  }, []);

  const open = async (id: string) => {
    try {
      const detail = await api.getSession(id);
      setSelected(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
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
        <div className="w-72 shrink-0">
          {error && <p className="text-sm text-red-400">{error}</p>}
          {sessions.length === 0 && (
            <div className="rounded-2xl border border-dashed border-surface-border py-10 text-center text-sm text-ink-faint">
              Сессий пока нет
            </div>
          )}
          <div className="space-y-1.5">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => open(s.id)}
                className={`block w-full rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                  selected?.id === s.id
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-surface-border bg-surface-light hover:border-surface-border-strong hover:bg-surface-hover'
                }`}
              >
                <p className="truncate text-sm font-medium text-ink">{s.title || s.mode}</p>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {new Date(s.started_at).toLocaleString()}
                </p>
              </button>
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
              <h3 className="mb-3 text-lg font-semibold tracking-tight text-ink">
                {selected.title || selected.mode}
              </h3>
              {selected.summary && (
                <div className="card mb-4 whitespace-pre-wrap p-4 text-sm leading-relaxed text-ink">
                  {selected.summary}
                </div>
              )}
              {selected.answers.length > 0 && (
                <div className="space-y-3">
                  {selected.answers.map((a) => (
                    <div key={a.id} className="card p-4">
                      <p className="mb-1.5 text-sm font-medium text-accent">{a.question}</p>
                      <p className="whitespace-pre-wrap text-sm text-ink-muted">{a.spoken || a.short}</p>
                    </div>
                  ))}
                </div>
              )}
              {selected.transcripts.length > 0 && (
                <div className="mt-4 space-y-1 text-sm text-ink-muted">
                  {selected.transcripts.map((t, i) => (
                    <p key={i}>
                      <span className="text-ink-faint">{t.speaker}:</span> {t.text}
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
