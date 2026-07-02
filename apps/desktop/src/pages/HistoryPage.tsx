import { useCallback, useEffect, useMemo, useState } from 'react';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import { api, SessionItem, SessionDetail } from '../lib/api';
import { buildStoredSessionExport } from '../lib/interviewSessionExport';
import {
  listSessions as listMockSessions,
  deleteSession as deleteMockSession,
} from '../lib/vacancyReview/vacancyReviewStore';
import type { ReadinessLabel, SmokeReviewSession } from '../lib/vacancyReview/types';

type SourceFilter = 'all' | 'interview' | 'meeting' | 'mock';

const SOURCE_TABS: { id: SourceFilter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'interview', label: 'Live' },
  { id: 'mock', label: 'Мок' },
  { id: 'meeting', label: 'Разбор' },
];

const READINESS_LABELS: Record<ReadinessLabel, string> = {
  not_ready: 'Не готов',
  weak: 'Слабо',
  almost_ready: 'Почти готов',
  ready: 'Готов',
  strong: 'Сильный уровень',
};

/** Единый элемент списка: сессии backend (live/meeting) + локальные мок-сессии. */
type HistoryRow =
  | { kind: 'backend'; id: string; startedAt: number; session: SessionItem }
  | { kind: 'mock'; id: string; startedAt: number; session: SmokeReviewSession };

function sourceBadge(row: HistoryRow) {
  if (row.kind === 'mock') return { label: 'Мок' };
  return row.session.mode === 'meeting' ? { label: 'Разбор' } : { label: 'Live' };
}

function speakerLabel(speaker: string) {
  return speaker === 'me' ? 'Вы' : 'Интервьюер';
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

function MockSessionDetail({ session }: { session: SmokeReviewSession }) {
  const report = session.report;
  const answered = session.answers.filter((a) => !a.skipped);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="prep-eyebrow">Мок-интервью</p>
          <h2 className="prep-h2 prep-section-title">
            {session.vacancyAnalysis.targetRole || 'Мок-интервью по вакансии'}
          </h2>
        </div>
        <p className="prep-faint">
          {answered.length}/{session.questions.length} вопросов ·{' '}
          {new Date(session.startedAt).toLocaleString()}
        </p>
      </div>

      {report && (
        <div className="prep-preview-card space-y-3 text-sm leading-relaxed">
          <p className="text-[15px] font-semibold">
            Готовность: {report.overallScore}/100 — {READINESS_LABELS[report.status]}
          </p>
          {report.strengths.length > 0 && (
            <div>
              <p className="font-semibold">Сильные стороны</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {report.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {report.weakAreas.length > 0 && (
            <div>
              <p className="font-semibold">Слабые места</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {report.weakAreas.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {report.criticalGaps.length > 0 && (
            <div>
              <p className="font-semibold">Критичные пробелы</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {report.criticalGaps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {report.nextPracticePlan.length > 0 && (
            <div>
              <p className="font-semibold">План тренировки</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {report.nextPracticePlan.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {answered.length > 0 && (
        <div className="space-y-3">
          {answered.map((answer) => {
            const question = session.questions.find((q) => q.id === answer.questionId);
            return (
              <article key={answer.questionId} className="prep-answer-review">
                <p className="prep-answer-question">{question?.question ?? 'Вопрос'}</p>
                <p className="prep-answer-text">{answer.text}</p>
                {answer.evaluation && (
                  <p className="prep-faint mt-2">
                    {answer.evaluation.score}/100 — {answer.evaluation.feedback}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function HistoryPage() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [mockSessions, setMockSessions] = useState<SmokeReviewSession[]>([]);
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [selectedMock, setSelectedMock] = useState<SmokeReviewSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    setMockSessions(listMockSessions());
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
      setSelectedMock(null);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось открыть сессию');
    }
  };

  const openMock = (session: SmokeReviewSession) => {
    setSelectedMock(session);
    setSelected(null);
    setError('');
  };

  const remove = async (row: HistoryRow) => {
    if (!window.confirm('Удалить сессию и все связанные ответы?')) return;
    setDeletingId(row.id);
    setError('');
    try {
      if (row.kind === 'mock') {
        deleteMockSession(row.id);
        setMockSessions(listMockSessions());
        if (selectedMock?.id === row.id) setSelectedMock(null);
      } else {
        await api.deleteSession(row.id);
        setSessions((prev) => prev.filter((item) => item.id !== row.id));
        if (selected?.id === row.id) setSelected(null);
      }
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

  const rows = useMemo<HistoryRow[]>(() => {
    const backendRows: HistoryRow[] = sessions.map((s) => ({
      kind: 'backend',
      id: s.id,
      startedAt: new Date(s.started_at).getTime(),
      session: s,
    }));
    const mockRows: HistoryRow[] = mockSessions.map((s) => ({
      kind: 'mock',
      id: s.id,
      startedAt: s.startedAt,
      session: s,
    }));
    return [...backendRows, ...mockRows].sort((a, b) => b.startedAt - a.startedAt);
  }, [sessions, mockSessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (source === 'mock' && row.kind !== 'mock') return false;
      if ((source === 'interview' || source === 'meeting') &&
        (row.kind !== 'backend' || row.session.mode !== source)) {
        return false;
      }
      if (!q) return true;
      const title =
        row.kind === 'mock'
          ? `мок ${row.session.vacancyAnalysis.targetRole}`
          : `${row.session.title ?? ''} ${row.session.mode}`;
      const hay = `${title} ${new Date(row.startedAt).toLocaleString()}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query, source]);

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise prep-home">
        <section>
          <p className="prep-eyebrow">История интервью</p>
          <h1 className="prep-h1 mt-1">Вернитесь к вопросам, где было сложно.</h1>
          <p className="prep-sub mt-1.5 max-w-2xl">
            Live-сессии, мок-интервью и разборы разговоров — в одном месте. Откройте, чтобы
            разобрать вопросы и сохранить удачные формулировки.
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
                <p className="prep-h2">{rows.length === 0 ? 'Сессий пока нет' : 'Ничего не найдено'}</p>
                <p className="prep-sub mt-1">
                  После live-интервью, мока или разбора здесь появятся вопросы, ответы и транскрипт.
                </p>
              </div>
            )}
            {filtered.map((row) => {
              const badge = sourceBadge(row);
              const active =
                row.kind === 'mock' ? selectedMock?.id === row.id : selected?.id === row.id;
              const isLive = row.kind === 'backend' && row.session.mode !== 'meeting';
              const title =
                row.kind === 'mock'
                  ? `Мок: ${row.session.vacancyAnalysis.targetRole || 'по вакансии'}`
                  : row.session.title ||
                    (row.session.mode === 'meeting' ? 'Разбор разговора' : 'Live-сессия');
              const subtitle =
                row.kind === 'mock'
                  ? `${badge.label} · ${new Date(row.startedAt).toLocaleDateString()} · ${
                      row.session.report ? `${row.session.report.overallScore}/100` : 'без отчёта'
                    }`
                  : `${badge.label} · ${new Date(row.startedAt).toLocaleDateString()} · ${
                      row.session.answer_count ?? 0
                    } ответов`;
              return (
                <div key={row.id} className={`prep-session-row ${active ? 'is-active' : ''}`}>
                  <button
                    type="button"
                    onClick={() => (row.kind === 'mock' ? openMock(row.session) : void open(row.id))}
                    className="prep-session-open"
                  >
                    <span className={`prep-session-dot ${isLive ? 'is-live' : 'is-manual'}`} />
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-[14.5px] font-semibold"
                        style={{ color: 'var(--prep-ink)' }}
                      >
                        {title}
                      </p>
                      <p className="prep-faint mt-0.5">{subtitle}</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(row)}
                    disabled={deletingId === row.id}
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
            {!selected && !selectedMock && (
              <div className="prep-empty-state h-full min-h-[420px]">
                <p className="prep-h2">Выберите сессию слева</p>
                <p className="prep-sub mt-1">
                  Здесь появятся вопросы, ответы и транскрипт для разбора после интервью.
                </p>
              </div>
            )}
            {selectedMock && <MockSessionDetail session={selectedMock} />}
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
                        <span>{speakerLabel(line.speaker)}:</span> {line.text}
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
