import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '../components/Modal';
import OnboardingWizard, { isOnboardingDismissed } from '../components/OnboardingWizard';
import ReadinessRing from '../components/prepare/ReadinessRing';
import { api, type SessionStats } from '../lib/api';
import { useApp } from '../context/AppContext';
import { useI18n } from '../lib/i18n';
import { launchLive } from '../lib/launchLive';
import { pluralRu } from '../lib/pluralRu';
import { readinessLabelText, readinessTone, topicStatusTone } from '../lib/vacancyReview/readiness';
import {
  deleteSession,
  latestCompleted,
  latestInProgress,
  listSessions,
} from '../lib/vacancyReview/vacancyReviewStore';

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

function readMockStore() {
  return {
    sessions: listSessions(),
    inProgress: latestInProgress(),
    completed: latestCompleted(),
  };
}

export default function HomePage() {
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  // Плюрализация: русские формы через pluralRu, английские — singular/plural.
  const pl = (n: number, ru: [string, string, string], en: [string, string]) =>
    lang === 'en' ? (n === 1 ? en[0] : en[1]) : pluralRu(n, ru[0], ru[1], ru[2]);
  const { backendOnline, hasAnyKey, hasStt } = useApp();
  const [mockStore, setMockStore] = useState(readMockStore);
  const { sessions, inProgress, completed } = mockStore;
  const report = completed?.report;
  const [docCounts, setDocCounts] = useState({ resume: 0, legend: 0, vacancy: 0 });
  const [onboardingHidden, setOnboardingHidden] = useState(isOnboardingDismissed);

  // Re-read after the launch reconcile pulls sessions from the backend store.
  useEffect(() => {
    const refresh = () => setMockStore(readMockStore());
    window.addEventListener('skillcue:mock-sessions-synced', refresh);
    return () => window.removeEventListener('skillcue:mock-sessions-synced', refresh);
  }, []);

  const [stats, setStats] = useState<SessionStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .sessionStats()
      .then((data) => !cancelled && setStats(data))
      .catch(() => {
        /* бэкенд недоступен — просто не показываем блок аналитики */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [packReady, setPackReady] = useState<boolean | null>(null);
  const refreshDocs = useCallback(() => {
    api
      .listDocuments()
      .then((res) => {
        setDocCounts({
          resume: res.documents.filter((doc) => doc.kind === 'resume').length,
          legend: res.documents.filter((doc) => doc.kind === 'legend').length,
          vacancy: res.documents.filter((doc) => doc.kind === 'vacancy').length,
        });
      })
      .catch(() => {
        /* backend may still be starting */
      });
    api
      .profilePackStatus()
      .then((s) => setPackReady(s.exists))
      .catch(() => {
        /* backend may still be starting — чек покажет только наличие документов */
      });
  }, []);
  useEffect(() => {
    refreshDocs();
  }, [refreshDocs]);

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const removeSession = (id: string, title: string) => setDeleteTarget({ id, title });
  const confirmRemove = () => {
    if (!deleteTarget) return;
    deleteSession(deleteTarget.id);
    setDeleteTarget(null);
    setMockStore(readMockStore());
  };

  const weakest = report
    ? [...report.topicScores].sort((a, b) => a.score - b.score).slice(0, 3)
    : [];

  const hasContext = docCounts.resume > 0 || docCounts.legend > 0;
  const primaryAction = inProgress
    ? {
        label: t('home.action.continueMock'),
        onClick: () => navigate(`/prepare?session=${inProgress.id}`),
      }
    : report && weakest.length > 0
      ? {
          label: t('home.action.repeatWeak'),
          onClick: () => navigate(`/prepare?session=${completed!.id}&focusTopic=${weakest[0].topicId}`),
        }
      : report
        ? {
            label: t('home.action.openReadiness'),
            onClick: () => navigate(`/prepare?session=${completed!.id}`),
          }
        : {
            label: t('home.action.reviewVacancy'),
            onClick: () => navigate('/prepare'),
          };

  const inProgressPct = inProgress?.questions.length
    ? Math.round((inProgress.answers.length / inProgress.questions.length) * 100)
    : 0;

  // Мастер первого запуска: пока нет ни одной мок-сессии и не хватает документов.
  const showOnboarding =
    !onboardingHidden && sessions.length === 0 && (docCounts.resume === 0 || docCounts.vacancy === 0);

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise prep-home">
        {showOnboarding && (
          <OnboardingWizard
            hasResume={docCounts.resume > 0}
            hasVacancy={docCounts.vacancy > 0}
            onDocsChanged={refreshDocs}
            onDismiss={() => setOnboardingHidden(true)}
          />
        )}
        <section className="prep-hero-panel prep-cockpit-panel">
          <div className="prep-hero-copy">
            <p className="prep-eyebrow">{t('home.eyebrow')}</p>
            <h1 className="prep-h1 prep-hero-title">
              {inProgress
                ? t('home.title.inProgress')
                : report
                  ? t('home.title.report')
                  : t('home.title.empty')}
            </h1>
            <p className="prep-sub prep-hero-sub">{t('home.hero.sub')}</p>

            <div className="prep-hero-actions">
              <button type="button" className="prep-btn" onClick={primaryAction.onClick}>
                {primaryAction.label}
              </button>
              <button
                type="button"
                className="prep-btn prep-btn-secondary"
                onClick={() => navigate('/documents')}
              >
                {t('home.action.connectResume')}
              </button>
              <button
                type="button"
                className="prep-btn prep-btn-secondary"
                onClick={() => launchLive(() => navigate('/overlay'))}
              >
                {t('home.action.openLive')}
              </button>
              <button
                type="button"
                className="prep-btn prep-btn-ghost"
                onClick={() => navigate('/demo')}
                title={t('home.demo.title')}
              >
                {t('home.action.demo')}
              </button>
            </div>

            <div className="prep-flow-line" aria-label="SkillCue workflow">
              <span>{t('home.flow.vacancy')}</span>
              <span>{t('home.flow.mock')}</span>
              <span>{t('home.flow.readiness')}</span>
              <span>{t('home.flow.liveHint')}</span>
            </div>
          </div>

          <div className="prep-live-readiness" aria-label={t('home.readiness.aria')}>
            <div>
              <p className="prep-eyebrow">{t('home.readiness.eyebrow')}</p>
              <h2 className="prep-h2 prep-card-title">{t('home.readiness.title')}</h2>
            </div>
            <div className="prep-readiness-list">
              <ReadinessCheck
                label={t('home.check.vacancy')}
                detail={
                  report
                    ? t('home.check.vacancy.done')
                    : inProgress
                      ? t('home.check.vacancy.inProgress')
                      : t('home.check.vacancy.empty')
                }
                ok={Boolean(report || inProgress)}
                onClick={() => navigate('/prepare')}
              />
              <ReadinessCheck
                label={t('home.check.resume')}
                detail={
                  hasContext
                    ? packReady
                      ? t('home.check.resume.packReady')
                      : t('home.check.resume.docs')
                    : t('home.check.resume.empty')
                }
                ok={hasContext}
                onClick={() => navigate('/documents')}
              />
              <ReadinessCheck
                label={t('home.check.ai')}
                detail={
                  backendOnline && hasAnyKey && hasStt
                    ? t('home.check.ai.ready')
                    : t('home.check.ai.empty')
                }
                ok={backendOnline && hasAnyKey && hasStt}
                onClick={() => navigate(hasAnyKey ? '/settings?tab=speech' : '/settings?tab=ai')}
              />
            </div>
          </div>
        </section>

        {/* Состояние (вакансия/резюме/AI) показывает чеклист «Готовность» в герое —
            отдельный ряд статус-карточек дублировал его и убран. */}
        <section className="prep-home-grid">
          <div className="prep-action-card">
            {report ? (
              <div className="prep-report-layout">
                <ReadinessRing
                  score={report.overallScore}
                  label={readinessLabelText(report.status)}
                  tone={readinessTone(report.status)}
                  size={126}
                />
                <div className="min-w-0">
                  <p className="prep-faint">{t('home.report.last')}</p>
                  <h2 className="prep-h2 prep-card-title truncate">{completed?.vacancyAnalysis.targetRole}</h2>
                  <p className="prep-sub mt-2">
                    {/* topicScores — только темы, затронутые в mock; общее число тем
                        берём из разбора, иначе «1 тема» читается как потеря данных. */}
                    {t('home.report.topicsDone')} {report.topicScores.length} {t('home.report.of')}{' '}
                    {completed?.vacancyAnalysis.interviewTopics.length ?? report.topicScores.length},{' '}
                    {report.strengths.length}{' '}
                    {pl(
                      report.strengths.length,
                      ['сильная зона', 'сильные зоны', 'сильных зон'],
                      ['strong area', 'strong areas'],
                    )}
                    , {report.criticalGaps.length}{' '}
                    {pl(
                      report.criticalGaps.length,
                      ['критичный пробел', 'критичных пробела', 'критичных пробелов'],
                      ['critical gap', 'critical gaps'],
                    )}
                    .
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="prep-btn prep-btn-sm"
                      onClick={() => navigate(`/prepare?session=${completed!.id}`)}
                    >
                      {t('home.action.openReadiness')}
                    </button>
                    <button
                      type="button"
                      className="prep-btn-ghost prep-btn-sm"
                      onClick={() => removeSession(completed!.id, completed!.vacancyAnalysis.targetRole)}
                    >
                      {t('home.report.deleteReview')}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyReadiness onStart={() => navigate('/prepare')} />
            )}
          </div>

          <div className="prep-next-card">
            <p className="prep-faint">{t('home.next.eyebrow')}</p>
            {inProgress ? (
              <>
                <h2 className="prep-h2 prep-card-title truncate">{inProgress.vacancyAnalysis.targetRole}</h2>
                <p className="prep-sub mt-2">
                  {inProgress.answers.length} {t('home.report.of')} {inProgress.questions.length}{' '}
                  {t('home.next.questionsDone')}
                </p>
                <div className="prep-bar prep-bar-green mt-4">
                  <span style={{ width: `${inProgressPct}%` }} />
                </div>
                <button
                  type="button"
                  className="prep-btn prep-btn-sm mt-5 self-start"
                  onClick={() => navigate(`/prepare?session=${inProgress.id}`)}
                >
                  {t('home.action.continueMock')}
                </button>
              </>
            ) : (
              <>
                <h2 className="prep-h2 prep-card-title">{t('home.how.title')}</h2>
                <ol className="mt-3 grid gap-2.5">
                  {[t('home.how.step1'), t('home.how.step2'), t('home.how.step3')].map((step, i) => (
                    <li key={step} className="prep-sub flex gap-2.5">
                      <span
                        className="font-bold"
                        style={{ color: 'var(--prep-green)' }}
                      >
                        {i + 1}.
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </section>

        {report && (
          <section className="mt-5">
            <div className="prep-preview-card">
              <div>
                <p className="prep-eyebrow">{t('home.flow.readiness')}</p>
                <h2 className="prep-h2 prep-section-title">{t('home.map.title')}</h2>
              </div>
              <div className="prep-skill-list">
                {report.topicScores.slice(0, 6).map((topic) => (
                  <div key={topic.topicId} className="prep-skill-row">
                    <div className="prep-skill-label">
                      <span>{topic.title}</span>
                      <strong>{topic.score}%</strong>
                    </div>
                    <div className={`prep-skill-track prep-skill-${topicStatusTone(topic.status)}`}>
                      <span style={{ width: `${topic.score}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {weakest.length > 0 && (
          <section className="mt-5">
            <div className="prep-section-head">
              <div>
                <p className="prep-eyebrow">{t('home.focus.eyebrow')}</p>
                <h2 className="prep-h2 prep-section-title">{t('home.focus.title')}</h2>
              </div>
              <button
                type="button"
                className="prep-btn prep-btn-ghost prep-btn-sm"
                onClick={() => navigate(`/prepare?session=${completed!.id}`)}
              >
                {t('home.focus.practice')}
              </button>
            </div>
            <div className="prep-topic-grid">
              {weakest.map((topic) => {
                const tone = topicStatusTone(topic.status);
                return (
                  <div
                    key={topic.topicId}
                    className={`prep-card prep-card-lift p-4 prep-topic prep-topic-${tone}`}
                  >
                    <p className="prep-h2 pl-2 truncate">{topic.title}</p>
                    <p className="pl-2 text-[22px] font-bold" style={{ color: `var(--prep-${tone})` }}>
                      {topic.score}%
                    </p>
                    <button
                      type="button"
                      className="prep-btn prep-btn-ghost prep-btn-sm ml-2 mt-3"
                      onClick={() => navigate(`/prepare?session=${completed!.id}&focusTopic=${topic.topicId}`)}
                    >
                      {t('home.focus.repeatTopic')}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {stats && stats.interview_sessions + stats.meeting_sessions > 0 && (
          <section className="mt-5">
            <div className="prep-section-head">
              <div>
                <p className="prep-eyebrow">{t('home.analytics.eyebrow')}</p>
                <h2 className="prep-h2 prep-section-title">{t('home.analytics.title')}</h2>
              </div>
              <button
                type="button"
                className="prep-btn prep-btn-ghost prep-btn-sm"
                onClick={() => navigate('/history')}
              >
                {t('home.analytics.openHistory')}
              </button>
            </div>
            <div className="prep-status-grid mt-3">
              <PrepStatusCard
                label={t('home.analytics.liveLabel')}
                title={`${stats.interview_sessions} ${pl(stats.interview_sessions, ['сессия', 'сессии', 'сессий'], ['session', 'sessions'])}`}
                body={`${stats.total_answers} ${pl(stats.total_answers, ['ответ', 'ответа', 'ответов'], ['answer', 'answers'])} ${t('home.analytics.total')}`}
                tone="green"
              />
              <PrepStatusCard
                label={t('home.analytics.paceLabel')}
                title={`~${stats.avg_answers_per_session} ${t('home.analytics.qPerSession')}`}
                body={
                  stats.last_session_at
                    ? `${t('home.analytics.last')} ${new Date(stats.last_session_at).toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU')}`
                    : t('home.analytics.noSessions')
                }
                tone="blue"
              />
              <PrepStatusCard
                label={t('home.analytics.topicsLabel')}
                title={
                  stats.top_topics.length > 0
                    ? stats.top_topics.slice(0, 3).map((tt) => tt.topic).join(', ')
                    : t('home.analytics.fewData')
                }
                body={t('home.analytics.fromQuestions')}
                tone="violet"
              />
            </div>
          </section>
        )}

        {sessions.length > 0 && (
          <section className="mt-5">
            <div className="prep-section-head">
              <div>
                <p className="prep-eyebrow">{t('nav.history')}</p>
                <h2 className="prep-h2 prep-section-title">{t('home.history.title')}</h2>
              </div>
            </div>
            <div className="mt-3 grid gap-2.5">
              {sessions.slice(0, 6).map((s) => (
                <div key={s.id} className="prep-session-row">
                  <button
                    type="button"
                    onClick={() => navigate(`/prepare?session=${s.id}`)}
                    className="prep-session-open"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-semibold" style={{ color: 'var(--prep-ink)' }}>
                        {s.vacancyAnalysis.targetRole}
                      </p>
                      <p className="prep-faint">
                        {new Date(s.startedAt).toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU')} ·{' '}
                        {s.status === 'completed' ? t('home.session.completed') : t('home.session.inProgress')}
                      </p>
                    </div>
                    <span className="prep-chip shrink-0">
                      {s.report ? `${s.report.overallScore}%` : `${s.answers.length}/${s.questions.length}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSession(s.id, s.vacancyAnalysis.targetRole)}
                    className="prep-session-row-del"
                    title={t('home.session.deleteTitle')}
                    aria-label={t('home.session.deleteTitle')}
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('home.deleteModal.title')}
        subtitle={deleteTarget ? `«${deleteTarget.title}» — ${t('home.deleteModal.irreversible')}` : undefined}
        footer={
          <>
            <button
              type="button"
              className="prep-btn-ghost prep-btn-sm"
              onClick={() => setDeleteTarget(null)}
            >
              {t('common.cancel')}
            </button>
            <button type="button" className="prep-btn prep-btn-sm" onClick={confirmRemove}>
              {t('common.delete')}
            </button>
          </>
        }
      />
    </div>
  );
}

function PrepStatusCard({
  label,
  title,
  body,
  tone,
}: {
  label: string;
  title: string;
  body: string;
  tone: 'green' | 'blue' | 'amber' | 'violet';
}) {
  return (
    <div className={`prep-status-card prep-status-${tone}`}>
      <p>{label}</p>
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function ReadinessCheck({
  label,
  detail,
  ok,
  onClick,
}: {
  label: string;
  detail: string;
  ok: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`prep-readiness-check ${ok ? 'is-ok' : 'is-warn'}`}
    >
      <span className="prep-readiness-check__dot" />
      <div className="min-w-0">
        <strong>{label}</strong>
        <p>{detail}</p>
      </div>
    </button>
  );
}

function EmptyReadiness({ onStart }: { onStart: () => void }) {
  const { t } = useI18n();
  return (
    <div className="prep-empty">
      <p className="prep-faint">{t('home.empty.eyebrow')}</p>
      <h2 className="prep-h2 prep-card-title">{t('home.empty.title')}</h2>
      <p className="prep-sub">{t('home.empty.body')}</p>
      <div className="prep-mini-results">
        <span>{t('home.empty.likelyQ')}</span>
        <span>{t('home.empty.weakTopics')}</span>
        <span>{t('home.empty.plan')}</span>
      </div>
      {/* В пустом состоянии герой уже показывает «Разобрать вакансию» — здесь
          та же цель, но с ожиданием по времени, чтобы не дублировать кнопку. */}
      <button type="button" className="prep-btn prep-btn-sm" onClick={onStart}>
        {t('home.empty.start')}
      </button>
    </div>
  );
}
