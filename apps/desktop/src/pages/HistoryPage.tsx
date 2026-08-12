import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import MarkdownText from '../components/MarkdownText';
import { api, SessionItem, SessionDetail, type DevelopmentProfile, type SessionAssessment } from '../lib/api';
import { buildCareerProgress } from '../lib/careerProgress';
import {
  GROWTH_PROFILE_UPDATED_EVENT,
  growthRoleLabel,
  readGrowthProfile,
} from '../lib/growthProfile';
import { buildStoredSessionExport } from '../lib/interviewSessionExport';
import { useI18n, type I18nKey } from '../lib/i18n';
import { launchLive } from '../lib/launchLive';
import {
  listSessions as listMockSessions,
  deleteSession as deleteMockSession,
} from '../lib/vacancyReview/vacancyReviewStore';
import type { ReadinessLabel, SmokeReviewSession } from '../lib/vacancyReview/types';
import { clearSessionKnowledge, refreshSessionKnowledge } from '../lib/sessionKnowledge';

type SourceFilter = 'all' | 'interview' | 'meeting' | 'mock';

const SOURCE_TABS: { id: SourceFilter; labelKey: I18nKey }[] = [
  { id: 'all', labelKey: 'history.tab.all' },
  { id: 'interview', labelKey: 'history.tab.live' },
  { id: 'mock', labelKey: 'history.tab.mock' },
  { id: 'meeting', labelKey: 'history.tab.meeting' },
];

const READINESS_KEY: Record<ReadinessLabel, I18nKey> = {
  not_ready: 'history.readiness.not_ready',
  weak: 'history.readiness.weak',
  almost_ready: 'history.readiness.almost_ready',
  ready: 'history.readiness.ready',
  strong: 'history.readiness.strong',
};

/** Единый элемент списка: сессии backend (live/meeting) + локальные мок-сессии. */
type HistoryRow =
  | { kind: 'backend'; id: string; startedAt: number; session: SessionItem }
  | { kind: 'mock'; id: string; startedAt: number; session: SmokeReviewSession };

function sourceBadgeKey(row: HistoryRow): I18nKey {
  if (row.kind === 'mock') return 'history.tab.mock';
  return row.session.mode === 'meeting' ? 'history.tab.meeting' : 'history.tab.live';
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
  const { t, lang } = useI18n();
  const loc = lang === 'en' ? 'en-US' : 'ru-RU';
  const report = session.report;
  const answered = session.answers.filter((a) => !a.skipped);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="prep-eyebrow">{t('history.mock.eyebrow')}</p>
          <h2 className="prep-h2 prep-section-title">
            {session.vacancyAnalysis.targetRole || t('history.mock.titleFallback')}
          </h2>
        </div>
        <p className="prep-faint">
          {answered.length}/{session.questions.length} {t('history.questions')} ·{' '}
          {new Date(session.startedAt).toLocaleString(loc)}
        </p>
      </div>

      {report && (
        <div className="prep-preview-card space-y-3 text-sm leading-relaxed">
          <p className="text-[15px] font-semibold">
            {t('history.mock.readiness')} {report.overallScore}/100 — {t(READINESS_KEY[report.status])}
          </p>
          {report.strengths.length > 0 && (
            <div>
              <p className="font-semibold">{t('history.mock.strengths')}</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {report.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {report.weakAreas.length > 0 && (
            <div>
              <p className="font-semibold">{t('history.mock.weakAreas')}</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {report.weakAreas.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {report.criticalGaps.length > 0 && (
            <div>
              <p className="font-semibold">{t('history.mock.criticalGaps')}</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {report.criticalGaps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {report.nextPracticePlan.length > 0 && (
            <div>
              <p className="font-semibold">{t('history.mock.plan')}</p>
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
                <p className="prep-answer-question">
                  {question?.question ?? t('history.mock.questionFallback')}
                </p>
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
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, lang } = useI18n();
  const loc = lang === 'en' ? 'en-US' : 'ru-RU';
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [mockSessions, setMockSessions] = useState<SmokeReviewSession[]>([]);
  const [developmentProfile, setDevelopmentProfile] = useState<DevelopmentProfile | null>(null);
  const [growthProfile, setGrowthProfile] = useState(readGrowthProfile);
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [selectedAnalysis, setSelectedAnalysis] = useState<SessionAssessment | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [selectedMock, setSelectedMock] = useState<SmokeReviewSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const openGenerationRef = useRef(0);
  const growthSummaryRef = useRef<HTMLElement>(null);
  const invalidatePendingOpen = () => {
    openGenerationRef.current += 1;
    setAnalysisLoading(false);
  };

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    setMockSessions(listMockSessions());
    try {
      const [res, profile] = await Promise.all([
        api.listSessions(),
        api.getDevelopmentProfile().catch(() => null),
      ]);
      setSessions(res.sessions);
      setDevelopmentProfile(profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('history.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Re-read after the launch reconcile pulls mock sessions from the backend.
  useEffect(() => {
    const refresh = () => setMockSessions(listMockSessions());
    window.addEventListener('skillcue:mock-sessions-synced', refresh);
    return () => window.removeEventListener('skillcue:mock-sessions-synced', refresh);
  }, []);

  useEffect(() => {
    const refresh = () => setGrowthProfile(readGrowthProfile());
    window.addEventListener(GROWTH_PROFILE_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(GROWTH_PROFILE_UPDATED_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (searchParams.get('view') !== 'growth') return;
    window.requestAnimationFrame(() => growthSummaryRef.current?.scrollIntoView({ block: 'start' }));
  }, [searchParams]);

  const openMock = (session: SmokeReviewSession) => {
    openGenerationRef.current += 1;
    setSelectedMock(session);
    setSelected(null);
    setSelectedAnalysis(null);
    setAnalysisLoading(false);
    setAnalysisError('');
    setError('');
  };

  const analyzeSelected = async () => {
    if (!selected) return;
    const generation = openGenerationRef.current;
    const selectedId = selected.id;
    setAnalysisLoading(true);
    setAnalysisError('');
    try {
      const result = await api.createSessionAnalysis(selected.id, lang);
      if (generation !== openGenerationRef.current) return;
      setSelectedAnalysis(result);
      void api.getDevelopmentProfile().then(setDevelopmentProfile).catch(() => {});
      await refreshSessionKnowledge().catch(() => {
        // The session analysis is already persisted; aggregate refresh is best-effort.
      });
    } catch (err) {
      if (generation !== openGenerationRef.current) return;
      setAnalysisError(err instanceof Error ? err.message : t('history.analysis.failed'));
    } finally {
      if (generation === openGenerationRef.current && selectedId === selected.id) {
        setAnalysisLoading(false);
      }
    }
  };

  const remove = async (row: HistoryRow) => {
    if (!window.confirm(t('history.confirmDelete'))) return;
    invalidatePendingOpen();
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
        if (selected?.id === row.id) {
          setSelected(null);
          setSelectedAnalysis(null);
        }
        await refreshSessionKnowledge().catch(() => clearSessionKnowledge());
        void api.getDevelopmentProfile().then(setDevelopmentProfile).catch(() => setDevelopmentProfile(null));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('history.deleteError'));
    } finally {
      setDeletingId(null);
    }
  };

  const removeAll = async () => {
    if (sessions.length === 0) return;
    if (!window.confirm(`${t('history.confirmDeleteAllPre')} (${sessions.length})? ${t('history.irreversible')}`))
      return;
    invalidatePendingOpen();
    setClearing(true);
    setError('');
    try {
      await api.deleteAllSessions();
      clearSessionKnowledge();
      setSessions([]);
      setDevelopmentProfile(null);
      setSelected(null);
      setSelectedAnalysis(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('history.deleteAllError'));
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
      const hay = `${title} ${new Date(row.startedAt).toLocaleString(loc)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, query, source, loc]);

  const careerProgress = useMemo(
    () => buildCareerProgress(mockSessions, developmentProfile),
    [mockSessions, developmentProfile],
  );
  const goalLabel = growthRoleLabel(growthProfile);
  const latestPractice = careerProgress.latestPractice;
  const latestScore = latestPractice?.report?.overallScore;
  const progressAction = !goalLabel
    ? {
        title: 'Сначала выберите профессиональную цель.',
        detail: 'Она задаст направление для новых разборов; уже сохранённые попытки останутся раздельными.',
        label: 'Выбрать цель',
        to: '/documents?mode=baseline&section=goal',
      }
    : !latestPractice
      ? {
          title: 'Пройдите первую практику по конкретной вакансии.',
          detail: 'Она создаст стартовую точку, которую позже можно сравнивать с повторной попыткой.',
          label: 'Разобрать вакансию',
          to: '/prepare',
        }
      : {
          title: careerProgress.nextTrainingAction || 'Повторите самую слабую тему из последней практики.',
          detail: 'Изменение балла будет показано только после сопоставимой попытки по той же роли.',
          label: 'Открыть последний результат',
          to: `/prepare?session=${encodeURIComponent(latestPractice.id)}`,
        };

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise prep-home">
        <section>
          <p className="prep-eyebrow">{t('history.eyebrow')}</p>
          <h1 className="prep-h1 mt-1">{t('history.title')}</h1>
        </section>

        <section ref={growthSummaryRef} className="history-growth-summary" aria-labelledby="history-growth-title">
          <div className="history-growth-summary__header">
            <div>
              <p className="prep-eyebrow">ЛИЧНЫЙ ПРОГРЕСС</p>
              <h2 id="history-growth-title" className="prep-h2 prep-section-title">Результаты и следующий шаг</h2>
            </div>
            <button type="button" className="prep-btn prep-btn-ghost prep-btn-sm" onClick={() => navigate('/documents?section=goal')}>
              {goalLabel ? 'Изменить цель' : 'Выбрать цель'}
            </button>
          </div>
          <div className="history-growth-metrics">
            <div>
              <small>ТЕКУЩАЯ ЦЕЛЬ</small>
              <strong>{goalLabel || 'Не выбрана'}</strong>
              <span>{goalLabel ? 'подставляется в новые разборы' : 'поможет связать новые разборы'}</span>
            </div>
            <div>
              <small>ПРАКТИКА</small>
              <strong>{latestScore == null ? 'Нет оценки' : `${latestScore}/100`}</strong>
              <span>
                {careerProgress.practiceDelta == null
                  ? careerProgress.scoredPracticeSessions > 0 ? 'пока нет сопоставимой повторной попытки' : 'завершённых попыток ещё нет'
                  : `${careerProgress.practiceDelta > 0 ? '+' : ''}${careerProgress.practiceDelta} к прошлой попытке по этой роли`}
              </span>
            </div>
            <div>
              <small>РЕАЛЬНЫЕ ИНТЕРВЬЮ</small>
              <strong>{careerProgress.confirmedInterviewSessions}</strong>
              <span>разобрано отдельно от тренировок</span>
            </div>
          </div>
          <div className="history-growth-next">
            <div>
              <small>СЛЕДУЮЩИЙ ШАГ</small>
              <strong>{progressAction.title}</strong>
              <p>{progressAction.detail}</p>
            </div>
            <button type="button" className="prep-btn" onClick={() => navigate(progressAction.to)}>
              {progressAction.label}
            </button>
          </div>
        </section>

        {(loading || rows.length > 0) && <section className="prep-history-toolbar mt-5">
          <div className="relative min-w-0 flex-1 basis-64">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('history.searchPlaceholder')}
              className="prep-input w-full"
            />
          </div>
          <div className="prep-segmented" role="group" aria-label={t('history.sourceAria')}>
            {SOURCE_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSource(tab.id)}
                className={source === tab.id ? 'prep-segmented-active' : ''}
              >
                {t(tab.labelKey)}
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
                {clearing ? t('history.deleting') : t('history.deleteAll')}
              </button>
            )}
          </div>
        </section>}

        {error && (
          <p className="text-[13px]" style={{ color: 'var(--prep-red)' }}>
            {error}
          </p>
        )}

        {!loading && rows.length === 0 ? (
          <section className="prep-history-zero">
            <span className="prep-history-zero__step">1</span>
            <div>
              <p className="prep-eyebrow">ПЕРВАЯ СЕССИЯ</p>
              <h2 className="prep-h2 mt-1">{t('history.empty.none')}</h2>
              <p className="prep-sub mt-1 max-w-xl">{t('history.empty.sub')}</p>
            </div>
            <button
              type="button"
              className="prep-btn prep-btn-sm"
              onClick={() => navigate('/prepare')}
            >
              {t('home.action.reviewVacancy')}
            </button>
          </section>
        ) : <section className="prep-history-grid">
          <div className="prep-session-list">
            {loading && <p className="prep-faint">{t('common.loading')}</p>}
            {!loading && filtered.length === 0 && (
              <div className="prep-empty-state">
                <p className="prep-h2">
                  {rows.length === 0 ? t('history.empty.none') : t('history.empty.notFound')}
                </p>
                <p className="prep-sub mt-1">{t('history.empty.sub')}</p>
                {rows.length === 0 && (
                  <button
                    type="button"
                    className="prep-btn prep-btn-sm mt-4"
                    onClick={() => navigate('/prepare')}
                  >
                    {t('home.action.reviewVacancy')}
                  </button>
                )}
              </div>
            )}
            {filtered.map((row) => {
              const badgeLabel = t(sourceBadgeKey(row));
              const active =
                row.kind === 'mock' ? selectedMock?.id === row.id : selected?.id === row.id;
              const isLive = row.kind === 'backend' && row.session.mode !== 'meeting';
              const title =
                row.kind === 'mock'
                  ? `${t('history.row.mock')} ${row.session.vacancyAnalysis.targetRole || t('history.row.forVacancy')}`
                  : row.session.title ||
                    (row.session.mode === 'meeting' ? t('history.row.meeting') : t('shell.liveSession'));
              const subtitle =
                row.kind === 'mock'
                  ? `${badgeLabel} · ${new Date(row.startedAt).toLocaleDateString(loc)} · ${
                      row.session.report ? `${row.session.report.overallScore}/100` : t('history.noReport')
                    }`
                  : `${badgeLabel} · ${new Date(row.startedAt).toLocaleDateString(loc)} · ${
                      row.session.answer_count ?? 0
                    } ${t('history.answers')}`;
              return (
                <div key={row.id} className={`prep-session-row ${active ? 'is-active' : ''}`}>
                  <button
                    type="button"
                    onClick={() =>
                      row.kind === 'mock'
                        ? openMock(row.session)
                        : navigate(`/history/${encodeURIComponent(row.id)}`)
                    }
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
                    title={t('history.deleteTitle')}
                    aria-label={t('history.deleteTitle')}
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
                <p className="prep-h2">{t('history.detail.empty.title')}</p>
                <p className="prep-sub mt-1">{t('history.detail.empty.sub')}</p>
              </div>
            )}
            {selectedMock && <MockSessionDetail session={selectedMock} />}
            {selectedMock && (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="prep-btn prep-btn-sm"
                  onClick={() => navigate(`/prepare?session=${selectedMock.id}`)}
                >
                  {t('home.action.openReadiness')}
                </button>
                <button
                  type="button"
                  className="prep-btn prep-btn-secondary prep-btn-sm"
                  onClick={() => launchLive(() => navigate('/overlay'))}
                >
                  {t('history.startLive')}
                </button>
              </div>
            )}
            {selected && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="prep-eyebrow">{t('history.detail.eyebrow')}</p>
                    <h2 className="prep-h2 prep-section-title">{selected.title || selected.mode}</h2>
                  </div>
                  <p className="prep-faint">
                    {selected.answers.length} {t('history.answers')} · {selected.transcripts.length}{' '}
                    {t('history.transcriptLines')}
                  </p>
                </div>

                {selected.summary && (
                  <div className="prep-preview-card whitespace-pre-wrap text-sm leading-relaxed">
                    {selected.summary}
                  </div>
                )}

                {analysisLoading && (
                  <div className="prep-preview-card prep-faint">
                    {t('history.analysis.loading')}
                  </div>
                )}

                {!analysisLoading && !selectedAnalysis && (
                  <div className="prep-preview-card">
                    <p className="prep-eyebrow mb-2">{t('history.analysis.title')}</p>
                    <p className="prep-sub max-w-xl">
                      {analysisError || t('history.analysis.empty')}
                    </p>
                    <button
                      type="button"
                      className="prep-btn prep-btn-sm mt-3"
                      onClick={() => void analyzeSelected()}
                    >
                      {analysisError
                        ? t('history.analysis.retry')
                        : t('history.analysis.create')}
                    </button>
                  </div>
                )}

                {selectedAnalysis && (
                  <div className="prep-preview-card text-sm leading-relaxed">
                    <p className="prep-eyebrow mb-2">{t('history.analysis.title')}</p>
                    <MarkdownText text={selectedAnalysis.markdown} />
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
                        <span>
                          {line.speaker === 'me' ? t('history.speaker.me') : t('history.speaker.other')}:
                        </span>{' '}
                        {line.text}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>}
      </div>
    </div>
  );
}
