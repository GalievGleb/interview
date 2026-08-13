import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Lightbulb,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api, type SessionAssessment, type SessionDetail } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { refreshSessionKnowledge } from '../lib/sessionKnowledge';
import { resolveSessionEvidenceLayout } from '../lib/sessionAnalysisPresentation';

function scoreColor(score: number): string {
  if (score >= 75) return 'var(--prep-green)';
  if (score >= 55) return 'var(--prep-amber)';
  return 'var(--prep-red)';
}

function cleanValue(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function isUnknownValue(value: string | null | undefined): boolean {
  const normalized = cleanValue(value).toLocaleLowerCase();
  return !normalized
    || normalized === 'unknown'
    || normalized === 'undefined'
    || normalized.includes('неопредел');
}

function hasReliableScore(analysis: SessionAssessment): boolean {
  return analysis.overallScore > 0
    && analysis.overallConfidence > 0
    && !isUnknownValue(analysis.overallLevel);
}

function hasRoleSeparationWarning(analysis: SessionAssessment): boolean {
  const conclusion = cleanValue(analysis.conclusion).toLocaleLowerCase();
  return conclusion.includes('роли участников не подтверждены')
    || conclusion.includes('один аудиоканал')
    || conclusion.includes('нельзя разделить надёжно')
    || conclusion.includes('speaker roles could not be confirmed')
    || conclusion.includes('single audio channel');
}

function candidateLinesLabel(count: number, ru: boolean): string {
  if (!ru) return `${count} of your lines`;
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} ваша реплика`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} ваши реплики`;
  }
  return `${count} ваших реплик`;
}

function reviewedAnswersLabel(count: number, ru: boolean): string {
  if (!ru) return `${count} answers reviewed`;
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} ответ разобран`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} ответа разобрано`;
  }
  return `${count} ответов разобрано`;
}

function getErrorMessage(reason: unknown, ru: boolean): string {
  const raw = reason instanceof Error ? reason.message : String(reason);
  if (/internal server error/i.test(raw)) {
    return ru
      ? 'Сервис разбора временно недоступен. Попробуйте ещё раз.'
      : 'The review service is temporarily unavailable. Try again.';
  }
  return raw;
}

export default function SessionAnalysisPage() {
  const { sessionId = '' } = useParams();
  const { lang } = useI18n();
  const ru = lang !== 'en';
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [analysis, setAnalysis] = useState<SessionAssessment | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');

  const generate = useCallback(
    async (force: boolean) => {
      if (!sessionId) return;
      setAnalyzing(true);
      setError('');
      try {
        const result = await api.createSessionAnalysis(sessionId, lang, force);
        setAnalysis(result);
        await refreshSessionKnowledge().catch(() => undefined);
      } catch (reason) {
        setError(getErrorMessage(reason, ru));
      } finally {
        setAnalyzing(false);
      }
    },
    [lang, ru, sessionId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const [detail, saved] = await Promise.all([
          api.getSession(sessionId),
          api.getSessionAnalysis(sessionId).catch(() => null),
        ]);
        if (cancelled) return;
        setSession(detail);
        setAnalysis(saved);
        setLoading(false);
        if (
          !saved
          || saved.analysisVersion !== 2
          || (saved.analysisLanguage != null && saved.analysisLanguage !== lang)
        ) {
          await generate(Boolean(saved));
        }
      } catch (reason) {
        if (cancelled) return;
        setError(getErrorMessage(reason, ru));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generate, lang, ru, sessionId]);

  const evidenceLayout = resolveSessionEvidenceLayout(
    analysis?.strengths.length ?? 0,
    analysis?.weaknesses.length ?? 0,
  );
  const candidateLineCount = session?.transcripts.filter((line) => line.speaker === 'me').length ?? 0;
  const reliableScore = analysis ? hasReliableScore(analysis) : false;
  const roleSeparationWarning = analysis ? hasRoleSeparationWarning(analysis) : false;
  const reliableReviews = useMemo(
    () => (analysis?.answerReviews ?? []).filter((review) => {
      const hasFeedback = review.whatWasGood.length > 0
        || review.problems.length > 0
        || review.missingPoints.length > 0
        || !isUnknownValue(review.betterAnswer);
      return review.score > 0 || hasFeedback;
    }),
    [analysis?.answerReviews],
  );
  const canAssess = !roleSeparationWarning
    && (reliableScore || reliableReviews.length > 0 || evidenceLayout.hasAny);
  const conclusion = cleanValue(analysis?.conclusion);
  const showConclusion = conclusion.length > 0 && !isUnknownValue(conclusion);

  return (
    <div className="prep session-review-page h-full overflow-y-auto">
      <main className="prep-wrap session-review">
        <Link className="session-review__back" to="/history">
          <ArrowLeft size={16} aria-hidden="true" />
          {ru ? 'Интервью' : 'Interviews'}
        </Link>

        <header className="session-review__header">
          <div className="min-w-0">
            <p className="prep-eyebrow">{ru ? 'РАЗБОР СЕССИИ' : 'SESSION REVIEW'}</p>
            <h1 className="prep-h1 mt-1">
              {session?.title || (ru ? 'Результаты интервью' : 'Interview results')}
            </h1>
            {session && (
              <p className="session-review__meta">
                <span>{new Intl.DateTimeFormat(ru ? 'ru-RU' : 'en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(session.started_at))}</span>
                <span aria-hidden="true">·</span>
                <span>{candidateLinesLabel(candidateLineCount, ru)}</span>
                {reliableReviews.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{reviewedAnswersLabel(reliableReviews.length, ru)}</span>
                  </>
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            className="prep-btn prep-btn-secondary prep-btn-sm"
            onClick={() => void generate(true)}
            disabled={analyzing || !session}
          >
            <RefreshCw size={14} className={analyzing ? 'motion-safe:animate-spin' : ''} aria-hidden="true" />
            {analyzing ? (ru ? 'Обновляю…' : 'Updating…') : ru ? 'Обновить разбор' : 'Update review'}
          </button>
        </header>

        {loading && (
          <div className="session-review__status" role="status">
            <RefreshCw size={18} className="motion-safe:animate-spin" aria-hidden="true" />
            <span>{ru ? 'Загружаю сессию…' : 'Loading session…'}</span>
          </div>
        )}

        {error && (
          <div className="growth-error session-review__error" role="alert">
            <TriangleAlert size={20} aria-hidden="true" />
            <div>
              <strong>{ru ? 'Разбор не обновился' : 'The review was not updated'}</strong>
              <p>{error}</p>
              {session && (
                <button type="button" onClick={() => void generate(true)} disabled={analyzing}>
                  {ru ? 'Попробовать ещё раз' : 'Try again'}
                </button>
              )}
            </div>
          </div>
        )}

        {analyzing && !analysis && (
          <div className="session-review__status" role="status" aria-live="polite">
            <RefreshCw size={18} className="motion-safe:animate-spin" aria-hidden="true" />
            <div>
              <strong>{ru ? 'Сопоставляю вопросы с ответами…' : 'Pairing questions with answers…'}</strong>
              <p>{ru ? 'Это может занять несколько секунд.' : 'This may take a few seconds.'}</p>
            </div>
          </div>
        )}

        {analysis && (
          <>
            {canAssess ? (
              <section className={`session-review__summary ${reliableScore ? 'has-score' : ''}`} aria-labelledby="session-summary-title">
                <div>
                  <p className="prep-eyebrow">{ru ? 'ГЛАВНОЕ' : 'SUMMARY'}</p>
                  <h2 id="session-summary-title" className="prep-h2 mt-1">
                    {ru ? 'Итог сессии' : 'Session summary'}
                  </h2>
                  {showConclusion && <p className="session-review__conclusion">{conclusion}</p>}
                  <p className="session-review__summary-note">
                    {ru
                      ? 'Только ваши реплики · подсказки не учитывались'
                      : 'Your lines only · assistant hints excluded'}
                  </p>
                </div>
                {reliableScore && (
                  <div className="session-review__score" aria-label={`${analysis.overallScore} ${ru ? 'из 100' : 'out of 100'}`}>
                    <strong style={{ color: scoreColor(analysis.overallScore) }}>{analysis.overallScore}</strong>
                    <span>/100</span>
                    <small>{analysis.overallLevel}</small>
                  </div>
                )}
              </section>
            ) : (
              <section className="session-review__empty" aria-labelledby="session-empty-title">
                <MessageSquareText size={22} aria-hidden="true" />
                <div>
                  <h2 id="session-empty-title">{ru ? 'Недостаточно данных для оценки' : 'Not enough data to assess'}</h2>
                  <p>
                    {roleSeparationWarning
                      ? ru
                        ? 'В записи один общий аудиоканал, поэтому нельзя надёжно понять, где вопрос, а где ваш ответ. Транскрипт сохранён ниже, но случайную оценку SkillCue не показывает.'
                        : 'The recording has one shared audio channel, so questions cannot be separated from your answers reliably. The transcript is saved below, but SkillCue does not show a misleading score.'
                      : candidateLineCount <= 1
                      ? ru
                        ? 'Записана только 1 ваша реплика, поэтому SkillCue не показывает случайный балл. Проверьте транскрипт ниже или проведите более длинную сессию.'
                        : 'Only 1 of your lines was recorded, so SkillCue does not show a misleading score. Check the transcript below or run a longer session.'
                      : ru
                        ? 'Не удалось надёжно отделить вопросы от ваших ответов. Проверьте транскрипт ниже.'
                        : 'Questions could not be separated from your answers reliably. Check the transcript below.'}
                  </p>
                </div>
              </section>
            )}

            {canAssess && reliableReviews.length > 0 && (
              <section className="session-review__answers" aria-labelledby="session-answers-title">
                <div className="session-review__section-heading">
                  <p className="prep-eyebrow">{ru ? 'ОТВЕТЫ' : 'ANSWERS'}</p>
                  <h2 id="session-answers-title" className="prep-h2 mt-1">
                    {ru ? 'Что улучшить' : 'What to improve'}
                  </h2>
                </div>

                <div className="session-review__answer-list">
                  {reliableReviews.map((review, index) => {
                    const answerScoreReliable = review.score > 0 && !isUnknownValue(review.topic);
                    const betterAnswer = !isUnknownValue(review.betterAnswer) ? review.betterAnswer : '';
                    return (
                      <article key={`${review.question}-${index}`} className="session-review__answer">
                        <div className="session-review__answer-head">
                          <div className="min-w-0">
                            {!isUnknownValue(review.topic) && <p className="prep-eyebrow">{review.topic}</p>}
                            <h3>{review.question || (ru ? `Ответ ${index + 1}` : `Answer ${index + 1}`)}</h3>
                          </div>
                          {answerScoreReliable && (
                            <strong style={{ color: scoreColor(review.score) }}>{review.score}/100</strong>
                          )}
                        </div>

                        <div className="session-review__quote">
                          <span>{ru ? 'Вы сказали' : 'You said'}</span>
                          <p>{review.candidateAnswer || (ru ? 'Ответ не распознан.' : 'The answer was not recognized.')}</p>
                        </div>

                        {(review.whatWasGood.length > 0 || review.problems.length > 0 || review.missingPoints.length > 0) && (
                          <div className="session-review__feedback-grid">
                            {review.whatWasGood.length > 0 && (
                              <section>
                                <h4><CheckCircle2 size={16} aria-hidden="true" />{ru ? 'Получилось' : 'Worked well'}</h4>
                                <ul>{review.whatWasGood.map((item) => <li key={item}>{item}</li>)}</ul>
                              </section>
                            )}
                            {(review.problems.length > 0 || review.missingPoints.length > 0) && (
                              <section>
                                <h4><XCircle size={16} aria-hidden="true" />{ru ? 'Не хватило' : 'Missing'}</h4>
                                <ul>{[...review.problems, ...review.missingPoints].map((item) => <li key={item}>{item}</li>)}</ul>
                              </section>
                            )}
                          </div>
                        )}

                        {betterAnswer && (
                          <section className="session-review__better-answer">
                            <h4><Lightbulb size={16} aria-hidden="true" />{ru ? 'Вариант сильнее' : 'A stronger answer'}</h4>
                            <p>{betterAnswer}</p>
                          </section>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {canAssess && evidenceLayout.hasAny && (
              <section className={`session-review__evidence ${evidenceLayout.isSplit ? 'is-split' : ''}`}>
                {evidenceLayout.hasStrengths && (
                  <article>
                    <h2><CheckCircle2 size={18} aria-hidden="true" />{ru ? 'Подтверждено' : 'Confirmed'}</h2>
                    <ul>{analysis.strengths.map((item) => <li key={item.topic}><strong>{item.topic}</strong><span>{item.evidence}</span></li>)}</ul>
                  </article>
                )}
                {evidenceLayout.hasWeaknesses && (
                  <article>
                    <h2><Sparkles size={18} aria-hidden="true" />{ru ? 'Следующий фокус' : 'Next focus'}</h2>
                    <ul>{analysis.weaknesses.map((item) => <li key={item.topic}><strong>{item.topic}</strong><span>{item.evidence}</span>{item.learningAction && <small>{item.learningAction}</small>}</li>)}</ul>
                  </article>
                )}
              </section>
            )}
          </>
        )}

        {session && (
          <section className="session-review__sources" aria-label={ru ? 'Материалы сессии' : 'Session materials'}>
            <details className="session-review__disclosure">
              <summary>
                <span><MessageSquareText size={17} aria-hidden="true" />{ru ? 'Полный транскрипт' : 'Full transcript'}</span>
                <ChevronDown size={17} aria-hidden="true" />
              </summary>
              <div className="prep-transcript-review">
                {session.transcripts.length > 0
                  ? session.transcripts.map((line, index) => (
                    <p key={`${line.ts}-${index}`}>
                      <span>{line.speaker === 'me' ? (ru ? 'Вы' : 'You') : (ru ? 'Интервьюер' : 'Interviewer')}:</span>{' '}
                      {line.text}
                    </p>
                  ))
                  : <p>{ru ? 'Транскрипт пуст.' : 'The transcript is empty.'}</p>}
              </div>
            </details>

            {session.answers.length > 0 && (
              <details className="session-review__disclosure">
                <summary>
                  <span><Sparkles size={17} aria-hidden="true" />{ru ? 'Подсказки помощника' : 'Assistant hints'}</span>
                  <ChevronDown size={17} aria-hidden="true" />
                </summary>
                <p className="session-review__disclosure-note">
                  {ru ? 'Не учитываются в оценке.' : 'Excluded from the assessment.'}
                </p>
                <div className="session-review__hint-list">
                  {session.answers.map((answer) => (
                    <article key={answer.id}>
                      <strong>{answer.question}</strong>
                      <p>{answer.spoken || answer.short}</p>
                    </article>
                  ))}
                </div>
              </details>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
