import { useCallback, useEffect, useMemo, useState } from 'react';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import { api, SessionItem, SessionDetail } from '../lib/api';
import { buildStoredSessionExport } from '../lib/interviewSessionExport';

type SourceFilter = 'all' | 'interview' | 'meeting';

const SOURCE_TABS: { id: SourceFilter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'interview', label: 'Live' },
  { id: 'meeting', label: 'Разбор' },
];

function sourceBadge(mode: string) {
  return mode === 'meeting'
    ? { label: 'Разбор', tone: 'prep-tone-blue' }
    : { label: 'Live', tone: 'prep-tone-green' };
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
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
      setError(err instanceof Error ? err.message : 'Ошибка загрузки истории');
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
      setError(err instanceof Error ? err.message : 'Не удалось открыть сессию');
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
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise prep-home">
        <section>
          <p className="prep-eyebrow">История интервью</p>
          <h1 className="prep-h1 mt-1">Вернитесь к вопросам, где было сложно.</h1>
          <p className="prep-sub mt-1.5 max-w-2xl">
            Каждая строка — одна сессия: источник, дата и число ответов. Откройте, чтобы разобрать
            вопросы и сохранить удачные формулировки.
          </p>
        </section>

        <section className="prep-history-toolbar mt-5">
          <div className="relative min-w-[260px] flex-1">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Найти по названию, дате или режиму..."
              className="prep-input w-full"
            />
          </div>
          <div className="prep-segmented" role="group" aria-label="Фильтр источника">
            {SOURCE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSource(t.id)}
                className={source === t.id ? 'prep-segmented-active' : ''}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {exportData && <InterviewExportButtons exportData={exportData} compact />}
            {sessions.length > 0 && (
              <button
                type="button"
                onClick={() => void removeAll()}
                disabled={clearing}
                className="prep-btn prep-btn-ghost prep-btn-sm"
              >
                {clearing ? 'Удаляю...' : 'Удалить все'}
              </button>
            )}
          </div>
        </section>

        {error && (
          <p className="text-[13px]" style={{ color: 'var(--prep-red)' }}>
            {error}
          </p>
        )}

        <section className="prep-history-grid">
          <div className="prep-session-list">
            {loading && <p className="prep-faint">Загрузка...</p>}
            {!loading && filtered.length === 0 && (
              <div className="prep-empty-state">
                <p className="prep-h2">{sessions.length === 0 ? 'Сессий пока нет' : 'Ничего не найдено'}</p>
                <p className="prep-sub mt-1">
                  После live-интервью здесь появятся вопросы, ответы и транскрипт.
                </p>
              </div>
            )}
            {filtered.map((session) => {
              const badge = sourceBadge(session.mode);
              const active = selected?.id === session.id;
              const isLive = session.mode !== 'meeting';
              return (
                <div key={session.id} className={`prep-session-row ${active ? 'is-active' : ''}`}>
                  <button type="button" onClick={() => open(session.id)} className="prep-session-open">
                    <span className={`prep-session-dot ${isLive ? 'is-live' : 'is-manual'}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14.5px] font-semibold" style={{ color: 'var(--prep-ink)' }}>
                        {session.title || (session.mode === 'meeting' ? 'Разбор разговора' : 'Live-сессия')}
                      </p>
                      <p className="prep-faint mt-0.5">
                        {badge.label} · {new Date(session.started_at).toLocaleDateString()} ·{' '}
                        {session.answer_count ?? 0} ответов
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(session.id)}
                    disabled={deletingId === session.id}
                    className="prep-session-row-del"
                    title="Удалить сессию"
                    aria-label="Удалить сессию"
                  >
                    <TrashIcon />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="prep-session-detail">
            {!selected && (
              <div className="prep-empty-state h-full min-h-[420px]">
                <p className="prep-h2">Выберите сессию слева</p>
                <p className="prep-sub mt-1">
                  Здесь появятся вопросы, ответы и транскрипт для разбора после интервью.
                </p>
              </div>
            )}
            {selected && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="prep-eyebrow">Разбор сессии</p>
                    <h2 className="prep-h2 prep-section-title">{selected.title || selected.mode}</h2>
                  </div>
                  <p className="prep-faint">
                    {selected.answers.length} ответов · {selected.transcripts.length} строк транскрипта
                  </p>
                </div>

                {selected.summary && (
                  <div className="prep-preview-card whitespace-pre-wrap text-sm leading-relaxed">
                    {selected.summary}
                  </div>
                )}

                {selected.answers.length > 0 && (
                  <div className="space-y-3">
                    {selected.answers.map((answer) => (
                      <article key={answer.id} className="prep-answer-review">
                        <p className="prep-answer-question">{answer.question}</p>
                        <p className="prep-answer-text">{answer.spoken || answer.short}</p>
                      </article>
                    ))}
                  </div>
                )}

                {selected.transcripts.length > 0 && (
                  <div className="prep-transcript-review">
                    {selected.transcripts.map((line, index) => (
                      <p key={index}>
                        <span>{line.speaker}:</span> {line.text}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
