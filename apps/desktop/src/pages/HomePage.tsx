import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReadinessRing from '../components/prepare/ReadinessRing';
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

export default function HomePage() {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const sessions = useMemo(() => listSessions(), [refreshKey]);
  const inProgress = useMemo(() => latestInProgress(), [refreshKey]);
  const completed = useMemo(() => latestCompleted(), [refreshKey]);
  const report = completed?.report;

  const removeSession = (id: string, title: string) => {
    if (!window.confirm(`Удалить разбор «${title}»? Действие необратимо.`)) return;
    deleteSession(id);
    setRefreshKey((k) => k + 1);
  };

  const weakest = report
    ? [...report.topicScores].sort((a, b) => a.score - b.score).slice(0, 3)
    : [];

  const inProgressPct = inProgress?.questions.length
    ? Math.round((inProgress.answers.length / inProgress.questions.length) * 100)
    : 0;

  return (
    <div className="prep h-full overflow-y-auto">
      <div className="prep-wrap prep-rise prep-home">
        <section className="prep-hero-panel">
          <div className="prep-hero-copy">
            <p className="prep-eyebrow">Preparation hub</p>
            <h1 className="prep-h1 prep-hero-title">Разберите вакансию до первого звонка.</h1>
            <p className="prep-sub prep-hero-sub">
              SkillCue показывает вероятные вопросы, слабые темы и короткие ответы, которые
              звучат как ваш реальный опыт, а не как общий AI-текст.
            </p>

            <div className="prep-hero-actions">
              <button type="button" className="prep-btn" onClick={() => navigate('/prepare')}>
                Разобрать вакансию
              </button>
              <button
                type="button"
                className="prep-btn prep-btn-secondary"
                onClick={() => navigate('/interview')}
              >
                Открыть live
              </button>
            </div>

            <div className="prep-flow-line" aria-label="SkillCue workflow">
              <span>Вакансия</span>
              <span>Разбор</span>
              <span>Mock</span>
              <span>Live cue</span>
            </div>
          </div>

          <div className="prep-hero-demo" aria-label="Live cue preview">
            <div className="prep-demo-window">
              <div className="prep-demo-top">
                <span>Live interview</span>
                <span className="prep-live-pill">Listening</span>
              </div>
              <div className="prep-demo-question">
                <span>Вопрос интервьюера</span>
                <strong>Как вы тестировали API кроме проверки статус-кода 200?</strong>
              </div>
              <div className="prep-demo-answer">
                <span>Подсказка SkillCue</span>
                <p>
                  Кроме статус-кода 200 я сверяю тело ответа с Pydantic-моделью: обязательные
                  поля, типы данных и бизнес-значения. Отдельно проверяю заголовки, права
                  доступа и негативные сценарии — некорректные payload’ы и граничные значения.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="prep-status-grid" aria-label="Readiness overview">
          <PrepStatusCard
            label="Vacancy"
            title={report ? completed?.vacancyAnalysis.targetRole || 'Reviewed role' : 'Нужна вакансия'}
            body={report ? `${report.topicScores.length} тем найдено` : 'Начните с описания роли'}
            tone={report ? 'green' : 'amber'}
          />
          <PrepStatusCard
            label="Resume / legend"
            title="Контекст ответа"
            body="SkillCue держит ответы в рамках вашего опыта"
            tone="blue"
          />
          <PrepStatusCard
            label="Live overlay"
            title="Короткая подсказка"
            body="Answer-first режим для реального созвона"
            tone="violet"
          />
        </section>

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
                  <p className="prep-faint">Последний разбор вакансии</p>
                  <h2 className="prep-h2 prep-card-title truncate">{completed?.vacancyAnalysis.targetRole}</h2>
                  <p className="prep-sub mt-2">
                    {report.topicScores.length} тем, {report.strengths.length} сильных зон,{' '}
                    {report.criticalGaps.length} критичных пробелов.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="prep-btn prep-btn-sm"
                      onClick={() => navigate(`/prepare?session=${completed!.id}`)}
                    >
                      Открыть карту готовности
                    </button>
                    <button
                      type="button"
                      className="prep-btn-ghost prep-btn-sm"
                      onClick={() => removeSession(completed!.id, completed!.vacancyAnalysis.targetRole)}
                    >
                      Удалить разбор
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <EmptyReadiness onStart={() => navigate('/prepare')} />
            )}
          </div>

          <div className="prep-next-card">
            <p className="prep-faint">Следующий шаг</p>
            {inProgress ? (
              <>
                <h2 className="prep-h2 prep-card-title truncate">{inProgress.vacancyAnalysis.targetRole}</h2>
                <p className="prep-sub mt-2">
                  {inProgress.answers.length} из {inProgress.questions.length} вопросов пройдено.
                </p>
                <div className="prep-bar prep-bar-green mt-4">
                  <span style={{ width: `${inProgressPct}%` }} />
                </div>
                <button
                  type="button"
                  className="prep-btn prep-btn-sm mt-5 self-start"
                  onClick={() => navigate(`/prepare?session=${inProgress.id}`)}
                >
                  Продолжить mock
                </button>
              </>
            ) : (
              <>
                <h2 className="prep-h2 prep-card-title">Сначала разберите вакансию</h2>
                <p className="prep-sub mt-2">
                  После разбора SkillCue соберет вероятные вопросы и покажет, где можно посыпаться.
                </p>
                <button
                  type="button"
                  className="prep-btn prep-btn-sm mt-5 self-start"
                  onClick={() => navigate('/prepare')}
                >
                  Вставить вакансию
                </button>
              </>
            )}
          </div>
        </section>

        {report && (
          <section className="mt-5">
            <div className="prep-preview-card">
              <div>
                <p className="prep-eyebrow">Карта готовности</p>
                <h2 className="prep-h2 prep-section-title">Понятно, где уверенно, а где нужен повтор.</h2>
              </div>
              <div className="prep-skill-list">
                {report.topicScores.slice(0, 6).map((t) => (
                  <div key={t.topicId} className="prep-skill-row">
                    <div className="prep-skill-label">
                      <span>{t.title}</span>
                      <strong>{t.score}%</strong>
                    </div>
                    <div className={`prep-skill-track prep-skill-${topicStatusTone(t.status)}`}>
                      <span style={{ width: `${t.score}%` }} />
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
                <p className="prep-eyebrow">Practice focus</p>
                <h2 className="prep-h2 prep-section-title">Самые слабые темы</h2>
              </div>
              <button
                type="button"
                className="prep-btn prep-btn-ghost prep-btn-sm"
                onClick={() => navigate(`/prepare?session=${completed!.id}`)}
              >
                Тренироваться
              </button>
            </div>
            <div className="prep-topic-grid">
              {weakest.map((t) => {
                const tone = topicStatusTone(t.status);
                return (
                  <div key={t.topicId} className={`prep-card p-4 prep-topic prep-topic-${tone}`}>
                    <p className="prep-h2 pl-2 truncate">{t.title}</p>
                    <p className="pl-2 text-[22px] font-bold" style={{ color: 'var(--prep-ink)' }}>
                      {t.score}%
                    </p>
                    <button
                      type="button"
                      className="prep-btn prep-btn-ghost prep-btn-sm ml-2 mt-3"
                      onClick={() => navigate(`/prepare?session=${completed!.id}&focusTopic=${t.topicId}`)}
                    >
                      Повторить тему
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {sessions.length > 0 && (
          <section className="mt-5">
            <div className="prep-section-head">
              <div>
                <p className="prep-eyebrow">History</p>
                <h2 className="prep-h2 prep-section-title">Последние mock-сессии</h2>
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
                        {new Date(s.startedAt).toLocaleDateString()} ·{' '}
                        {s.status === 'completed' ? 'завершено' : 'в процессе'}
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
                    title="Удалить сессию"
                    aria-label="Удалить сессию"
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
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

function EmptyReadiness({ onStart }: { onStart: () => void }) {
  return (
    <div className="prep-empty">
      <p className="prep-faint">Новая подготовка</p>
      <h2 className="prep-h2 prep-card-title">Начните с вакансии, а не с пустого чата.</h2>
      <p className="prep-sub">
        SkillCue выделит требования, вероятные вопросы и темы риска, чтобы mock-интервью было
        не общим, а под конкретную роль.
      </p>
      <div className="prep-mini-results">
        <span>Вероятные вопросы</span>
        <span>Слабые темы</span>
        <span>План подготовки</span>
      </div>
      <button type="button" className="prep-btn prep-btn-sm" onClick={onStart}>
        Разобрать вакансию
      </button>
    </div>
  );
}
