import { useCallback, useEffect, useMemo, useState } from 'react';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import ScreenHeader from '../components/ScreenHeader';
import { api, SessionItem, SessionDetail } from '../lib/api';
import { buildStoredSessionExport } from '../lib/interviewSessionExport';

type SourceFilter = 'all' | 'interview' | 'meeting';

const SOURCE_TABS: { id: SourceFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'interview', label: 'Live' },
  { id: 'meeting', label: 'Manual' },
];

function sourceBadge(mode: string) {
  return mode === 'meeting'
    ? { label: 'Manual', cls: 'sc-badge--accent' }
    : { label: 'Live', cls: 'sc-badge--success' };
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}

export default function HistoryPage() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');

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

  const removeAll = async () => {
    if (sessions.length === 0) return;
    if (!window.confirm(`Удалить все интервью (${sessions.length})? Действие необратимо.`)) return;
    setClearing(true);
    setError('');
    try {
      await api.deleteAllSessions();
      setSessions([]);
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось удалить все сессии');
    } finally {
      setClearing(false);
    }
  };

  const exportData = useMemo(
    () => (selected ? buildStoredSessionExport(selected) : null),
    [selected],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (source !== 'all' && s.mode !== source) return false;
      if (!q) return true;
      const hay = `${s.title ?? ''} ${s.mode} ${new Date(s.started_at).toLocaleString()}`.toLowerCase();
      return hay.includes(q);
    });
  }, [sessions, query, source]);

  return (
    <div>
      <ScreenHeader
        title="History"
        subtitle="Past questions and the answers SkillCue generated."
        actions={
          <>
            {exportData && <InterviewExportButtons exportData={exportData} compact />}
            {sessions.length > 0 && (
              <button
                type="button"
                onClick={() => void removeAll()}
                disabled={clearing}
                className="btn-danger btn-sm"
              >
                {clearing ? 'Удаление…' : 'Удалить все'}
              </button>
            )}
          </>
        }
      />

      {/* search + source filter */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-w-sm flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="field pl-9"
          />
        </div>
        <div className="sc-segmented" role="group" aria-label="Source filter">
          {SOURCE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSource(t.id)}
              className={`sc-segmented__item ${source === t.id ? 'sc-segmented__item--active' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <div className="flex gap-6">
        <div className="w-[360px] shrink-0 space-y-2">
          {loading && <p className="text-sm text-ink-faint">Загрузка…</p>}
          {!loading && filtered.length === 0 && (
            <div className="sc-empty rounded-2xl border border-dashed border-surface-border">
              {sessions.length === 0 ? 'Сессий пока нет' : 'Ничего не найдено'}
            </div>
          )}
          {filtered.map((session) => {
            const badge = sourceBadge(session.mode);
            const active = selected?.id === session.id;
            return (
              <div
                key={session.id}
                className={`group rounded-2xl border transition-colors ${
                  active
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-surface-border bg-surface-card hover:border-surface-border-strong'
                }`}
              >
                <button
                  type="button"
                  onClick={() => open(session.id)}
                  className="block w-full px-4 py-3 text-left"
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className={`sc-badge ${badge.cls}`}>
                      <span className={`sc-dot ${session.mode === 'meeting' ? '' : 'sc-dot--success'}`} />
                      {badge.label}
                    </span>
                    <span className="sc-mono text-[11px] text-ink-faint">
                      {new Date(session.started_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="truncate text-[15px] font-semibold text-ink">
                    {session.title || (session.mode === 'meeting' ? 'Разбор разговора' : 'Live session')}
                  </p>
                  <p className="sc-mono mt-1 text-[11px] text-ink-muted">
                    {session.answer_count ?? 0} answers · {session.transcript_count ?? 0} transcript lines
                  </p>
                </button>
                <div className="flex justify-end border-t border-surface-border/60 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => void remove(session.id)}
                    disabled={deletingId === session.id}
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink-faint transition hover:bg-red-950/30 hover:text-red-300 disabled:opacity-50"
                    title="Delete session"
                  >
                    <TrashIcon />
                    {deletingId === session.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="min-w-0 flex-1">
          {!selected && (
            <div className="sc-empty rounded-2xl border border-dashed border-surface-border py-20">
              Выберите сессию слева
            </div>
          )}
          {selected && (
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold tracking-tight text-ink">
                  {selected.title || selected.mode}
                </h3>
                <p className="sc-mono text-[11px] text-ink-faint">
                  {selected.answers.length} answers · {selected.transcripts.length} transcript lines
                </p>
              </div>
              {selected.summary && (
                <div className="sc-card mb-4 whitespace-pre-wrap p-4 text-sm leading-relaxed text-ink">
                  {selected.summary}
                </div>
              )}
              {selected.answers.length > 0 && (
                <div className="space-y-3">
                  {selected.answers.map((answer) => (
                    <div key={answer.id} className="sc-card p-4">
                      <p className="mb-1.5 text-sm font-semibold text-ink">{answer.question}</p>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
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
