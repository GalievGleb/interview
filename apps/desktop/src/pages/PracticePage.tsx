import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, BriefcaseBusiness, CheckCircle2, FileSearch, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { growthRoleLabel, readGrowthProfile } from '../lib/growthProfile';
import {
  deleteSession,
  listSessions,
  MOCK_SESSIONS_SYNCED_EVENT,
} from '../lib/vacancyReview/vacancyReviewStore';
import type { SmokeReviewSession } from '../lib/vacancyReview/types';
import type { InterviewCalendarEvent, InterviewCalendarState } from '../types/electron';
import Modal from '../components/Modal';

function sessionTitle(session: SmokeReviewSession): string {
  const role = session.vacancyAnalysis.targetRole || 'Практика';
  return session.vacancyAnalysis.contextKind === 'role' ? role : `По вакансии · ${role}`;
}

export default function PracticePage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState(listSessions);
  const [calendarState, setCalendarState] = useState<InterviewCalendarState | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<SmokeReviewSession | null>(null);
  const profile = readGrowthProfile();
  const goal = growthRoleLabel(profile);

  useEffect(() => {
    const refresh = () => setSessions(listSessions());
    window.addEventListener(MOCK_SESSIONS_SYNCED_EVENT, refresh);
    return () => window.removeEventListener(MOCK_SESSIONS_SYNCED_EVENT, refresh);
  }, []);

  useEffect(() => {
    const calendar = window.electronAPI?.interviewCalendar;
    if (!calendar) return;
    let active = true;
    void calendar.getState().then((next) => { if (active) setCalendarState(next); }).catch(() => undefined);
    const unsubscribe = calendar.onState((next) => { if (active) setCalendarState(next); });
    return () => { active = false; unsubscribe(); };
  }, []);

  const inProgress = useMemo(
    () => sessions.find((session) => session.status === 'in_progress'),
    [sessions],
  );
  const completed = useMemo(
    () => sessions.filter((session) => session.status === 'completed'),
    [sessions],
  );
  const answered = inProgress?.answers.filter((answer) => !answer.skipped).length ?? 0;
  const scheduledVacancy = useMemo(() => calendarState?.events
    .filter((event) => event.status !== 'cancelled' && +new Date(event.endAt) > Date.now())
    .filter((event) => Boolean(event.vacancyUrl?.trim() || event.sessionId))
    .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt))[0] ?? null, [calendarState]);

  const openScheduledPractice = (event: InterviewCalendarEvent) => {
    if (event.sessionId && sessions.some((session) => session.id === event.sessionId)) {
      navigate(`/practice/session?session=${encodeURIComponent(event.sessionId)}`);
      return;
    }
    if (event.vacancyUrl) {
      navigate(`/prepare?vacancyUrl=${encodeURIComponent(event.vacancyUrl)}&from=calendar&event=${encodeURIComponent(event.id)}`);
    }
  };

  const remove = (session: SmokeReviewSession) => {
    deleteSession(session.id);
    setSessions(listSessions());
    setSessionToDelete(null);
  };

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise practice-page">
        <header className="prep-page-heading">
          <p className="prep-eyebrow">ПРАКТИКА</p>
          <h1 className="prep-h1 mt-1">Тренировка ответов</h1>
        </header>

        {scheduledVacancy && <section className="practice-calendar-shortcut" aria-labelledby="practice-calendar-title">
          <div className="practice-calendar-shortcut__copy">
            <p className="prep-eyebrow">БЛИЖАЙШЕЕ СОБЕСЕДОВАНИЕ</p>
            <h2 id="practice-calendar-title">{scheduledVacancy.companyName} · {scheduledVacancy.vacancyTitle}</h2>
            <p>{new Date(scheduledVacancy.startAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</p>
          </div>
          <button type="button" className="prep-btn" onClick={() => openScheduledPractice(scheduledVacancy)}>Практика по вакансии <ArrowRight size={16} /></button>
        </section>}

        <section className="practice-primary" aria-labelledby="practice-primary-title">
          <span className="practice-primary__icon" aria-hidden="true">
            {inProgress ? <CheckCircle2 size={22} /> : <BriefcaseBusiness size={22} />}
          </span>
          <div className="practice-primary__copy">
            <p className="prep-eyebrow">{inProgress ? 'НЕ ЗАВЕРШЕНО' : goal ? 'ВАША ЦЕЛЬ' : 'БЕЗ ВАКАНСИИ'}</p>
            <h2 id="practice-primary-title">
              {inProgress ? sessionTitle(inProgress) : goal || 'Выберите роль перед стартом'}
            </h2>
            <p>
              {inProgress
                ? `${answered} из ${inProgress.questions.length} вопросов отвечено.`
                : 'SkillCue соберёт вопросы по роли. Вакансию добавлять не обязательно.'}
            </p>
          </div>
          <div className="practice-primary__actions">
            <button
              type="button"
              className="prep-btn"
              onClick={() => navigate(inProgress ? `/practice/session?session=${encodeURIComponent(inProgress.id)}` : '/practice/new')}
            >
              {inProgress ? 'Продолжить практику' : 'Начать практику'} <ArrowRight size={16} aria-hidden="true" />
            </button>
            <button type="button" className="prep-btn prep-btn-ghost" onClick={() => navigate('/prepare')}>
              <FileSearch size={15} aria-hidden="true" /> По вакансии
            </button>
          </div>
        </section>

        <section aria-labelledby="practice-history-title">
          <div className="prep-section-head">
            <div>
              <p className="prep-eyebrow">РЕЗУЛЬТАТЫ</p>
              <h2 id="practice-history-title" className="prep-h2 prep-section-title">Последние сессии</h2>
            </div>
            {completed.length > 0 && <span className="prep-faint">Завершено: {completed.length}</span>}
          </div>

          {sessions.length === 0 ? (
            <div className="practice-empty">
              <p>Здесь появятся ответы, оценка и темы для повторения.</p>
            </div>
          ) : (
            <div className="practice-session-list">
              {sessions.map((session) => {
                const score = session.report?.overallScore;
                const completedSession = session.status === 'completed';
                return (
                  <article key={session.id} className="practice-session-row">
                    <button
                      type="button"
                      className="practice-session-row__open"
                      onClick={() => navigate(`/practice/session?session=${encodeURIComponent(session.id)}`)}
                    >
                      <span className={`practice-session-row__status ${completedSession ? 'is-complete' : ''}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <strong>{sessionTitle(session)}</strong>
                        <small>
                          {new Date(session.startedAt).toLocaleDateString('ru-RU')} · {completedSession ? 'Завершено' : 'Не завершено'}
                        </small>
                      </span>
                      <span className="practice-session-row__score">{score == null ? '—' : `${score}/100`}</span>
                    </button>
                    <button
                      type="button"
                      className="prep-icon-button"
                      aria-label={`Удалить практику «${sessionTitle(session)}»`}
                      title="Удалить"
                      onClick={() => setSessionToDelete(session)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
      <Modal
        open={Boolean(sessionToDelete)}
        onClose={() => setSessionToDelete(null)}
        title="Удалить практику?"
        subtitle={sessionToDelete ? sessionTitle(sessionToDelete) : undefined}
        footer={(
          <>
            <button type="button" className="btn-secondary" onClick={() => setSessionToDelete(null)}>Отмена</button>
            <button type="button" className="btn-danger" onClick={() => sessionToDelete && remove(sessionToDelete)}>Удалить</button>
          </>
        )}
      >
        <p className="text-sm text-ink-muted">Ответы и результат этой попытки восстановить не получится.</p>
      </Modal>
    </div>
  );
}
