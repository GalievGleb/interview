import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronRight, Mic2, Send, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type SessionItem } from '../lib/api';
import { launchLive } from '../lib/launchLive';
import { clearSessionKnowledge, refreshSessionKnowledge } from '../lib/sessionKnowledge';
import Modal from '../components/Modal';
import { useApp } from '../context/AppContext';
import SessionReportModal from '../components/interview/SessionReportModal';

type SourceFilter = 'all' | 'interview' | 'meeting';

const FILTERS: Array<{ id: SourceFilter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'interview', label: 'Собеседования' },
  { id: 'meeting', label: 'Встречи' },
];

function sessionLabel(session: SessionItem): string {
  if (session.title?.trim()) return session.title;
  return session.mode === 'meeting' ? 'Встреча' : 'Собеседование';
}

export default function HistoryPage() {
  const navigate = useNavigate();
  const { backendOnline } = useApp();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [deletingId, setDeletingId] = useState('');
  const [clearing, setClearing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionItem | 'all' | null>(null);
  const [reportTarget, setReportTarget] = useState<SessionItem | null>(null);
  const initialLoadStartedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSessions((await api.listSessions()).sessions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить интервью.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The renderer can mount before the bundled backend has opened its port.
    // Load immediately for an already-running service, then retry exactly when
    // AppContext observes that a cold-started/restarted backend became healthy.
    if (!initialLoadStartedRef.current || backendOnline) {
      initialLoadStartedRef.current = true;
      void load();
    }
  }, [backendOnline, load]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (source !== 'all' && session.mode !== source) return false;
      if (!normalized) return true;
      return `${session.title ?? ''} ${session.mode}`.toLowerCase().includes(normalized);
    });
  }, [query, sessions, source]);

  const remove = async (session: SessionItem) => {
    setDeleteTarget(null);
    setDeletingId(session.id);
    setError('');
    try {
      await api.deleteSession(session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      await refreshSessionKnowledge().catch(() => clearSessionKnowledge());
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить интервью.');
    } finally {
      setDeletingId('');
    }
  };

  const removeAll = async () => {
    if (sessions.length === 0) return;
    setDeleteTarget(null);
    setClearing(true);
    setError('');
    try {
      await api.deleteAllSessions();
      clearSessionKnowledge();
      setSessions([]);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Не удалось очистить историю.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise practice-page">
        <header className="interview-page-heading">
          <div>
            <p className="prep-eyebrow">ИНТЕРВЬЮ</p>
            <h1 className="prep-h1 mt-1">Реальные разговоры</h1>
          </div>
          <div className="interview-page-heading__actions">
            <button type="button" className="prep-btn" onClick={() => launchLive(() => navigate('/overlay'))}>
              <Mic2 size={15} aria-hidden="true" /> Начать интервью
            </button>
            <button type="button" className="prep-btn prep-btn-ghost" onClick={() => navigate('/calendar')}>
              <CalendarDays size={15} aria-hidden="true" /> Календарь
            </button>
          </div>
        </header>

        <section aria-labelledby="interview-history-title">
          <div className="prep-section-head interview-history-heading">
            <div>
              <p className="prep-eyebrow">ИСТОРИЯ</p>
              <h2 id="interview-history-title" className="prep-h2 prep-section-title">Прошлые интервью</h2>
            </div>
            {sessions.length > 0 && (
              <div className="interview-history-heading__actions">
                <span className="prep-faint">Всего: {sessions.length}</span>
                <button type="button" className="prep-btn prep-btn-ghost prep-btn-sm" disabled={clearing} onClick={() => setDeleteTarget('all')}>
                  <Trash2 size={14} aria-hidden="true" /> {clearing ? 'Удаляем…' : 'Очистить историю'}
                </button>
              </div>
            )}
          </div>

          {sessions.length > 0 && (
            <div className="interview-toolbar">
              <label className="sr-only" htmlFor="interview-search">Найти интервью</label>
              <input
                id="interview-search"
                name="interviewSearch"
                className="prep-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Найти интервью"
                autoComplete="off"
              />
              <div className="prep-segmented" role="group" aria-label="Тип интервью">
                {FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    aria-pressed={source === filter.id}
                    className={source === filter.id ? 'is-active' : ''}
                    onClick={() => setSource(filter.id)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="prep-inline-error mt-3" role="alert">{error}</p>}
          {loading ? (
            <p className="prep-faint py-8" role="status">Загружаем интервью…</p>
          ) : sessions.length === 0 ? (
            <div className="practice-empty">
              <p>Истории пока нет. Запустите помощника перед реальным созвоном.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="practice-empty"><p>По этому фильтру ничего не найдено.</p></div>
          ) : (
            <div className="interview-session-list">
              {filtered.map((session) => (
                <article key={session.id} className="interview-session-row">
                  <button
                    type="button"
                    className="interview-session-row__open"
                    onClick={() => navigate(`/history/${encodeURIComponent(session.id)}`)}
                  >
                    <span className="interview-session-row__marker" aria-hidden="true"><Mic2 size={15} /></span>
                    <span className="min-w-0 flex-1">
                      <strong>{sessionLabel(session)}</strong>
                      <small>
                        {new Date(session.started_at).toLocaleString('ru-RU')} · {session.answer_count ?? 0} ответов
                      </small>
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="prep-btn prep-btn-ghost prep-btn-sm interview-session-row__report"
                    aria-label={`Отправить отчёт по интервью «${sessionLabel(session)}»`}
                    title="Отправить отчёт"
                    onClick={() => setReportTarget(session)}
                  >
                    <Send size={14} aria-hidden="true" /> <span>Отправить отчёт</span>
                  </button>
                  <button
                    type="button"
                    className="prep-icon-button"
                    disabled={deletingId === session.id}
                    aria-label={`Удалить интервью «${sessionLabel(session)}»`}
                    title="Удалить"
                    onClick={() => setDeleteTarget(session)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget === 'all' ? 'Очистить историю?' : 'Удалить интервью?'}
        subtitle={deleteTarget && deleteTarget !== 'all' ? sessionLabel(deleteTarget) : undefined}
        footer={(
          <>
            <button type="button" className="btn-secondary" onClick={() => setDeleteTarget(null)}>Отмена</button>
            <button
              type="button"
              className="btn-danger"
              disabled={clearing || Boolean(deletingId)}
              onClick={() => deleteTarget === 'all' ? void removeAll() : deleteTarget && void remove(deleteTarget)}
            >
              {deleteTarget === 'all' ? 'Удалить всё' : 'Удалить'}
            </button>
          </>
        )}
      >
        <p className="text-sm text-ink-muted">{deleteTarget === 'all' ? `Будут удалены все интервью (${sessions.length}).` : 'Запись и разбор восстановить не получится.'}</p>
      </Modal>
      <SessionReportModal session={reportTarget} onClose={() => setReportTarget(null)} />
    </div>
  );
}
