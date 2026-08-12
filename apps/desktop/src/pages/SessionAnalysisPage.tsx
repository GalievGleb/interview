import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Lightbulb, RefreshCw, TriangleAlert, XCircle } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type SessionAssessment, type SessionDetail } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { refreshSessionKnowledge } from '../lib/sessionKnowledge';
import { resolveSessionEvidenceLayout } from '../lib/sessionAnalysisPresentation';

function scoreColor(score: number): string {
  if (score >= 75) return 'var(--prep-green)';
  if (score >= 55) return 'var(--prep-amber)';
  return 'var(--prep-red)';
}

export default function SessionAnalysisPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
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
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setAnalyzing(false);
      }
    },
    [lang, sessionId],
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
        // Old one-paragraph reports did not preserve real question/answer evidence.
        // Opening the dedicated page upgrades them once to the structured format.
        if (
          !saved ||
          saved.analysisVersion !== 2 ||
          (saved.analysisLanguage != null && saved.analysisLanguage !== lang)
        ) {
          await generate(Boolean(saved));
        }
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generate, lang, sessionId]);

  const reviews = analysis?.answerReviews ?? [];
  const evidenceLayout = resolveSessionEvidenceLayout(
    analysis?.strengths.length ?? 0,
    analysis?.weaknesses.length ?? 0,
  );

  return (
    <div className="prep h-full overflow-y-auto">
      <main className="prep-wrap prep-rise prep-home max-w-[1120px]">
        <button
          type="button"
          className="prep-btn prep-btn-ghost prep-btn-sm mb-4"
          onClick={() => navigate('/history')}
        >
          <ArrowLeft size={15} /> {ru ? 'Все сессии' : 'All sessions'}
        </button>

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="prep-eyebrow">{ru ? 'РАЗБОР СЕССИИ' : 'SESSION REVIEW'}</p>
            <h1 className="prep-h1 mt-1">{ru ? 'Ваши реальные ответы' : 'Your actual answers'}</h1>
            <p className="prep-sub mt-2 max-w-3xl">
              {ru
                ? 'Оценка строится только по репликам «Вы» из транскрипта. Подсказки, которые генерировал ИИ во время созвона, не считаются вашими ответами.'
                : 'The assessment uses only your transcript lines. AI hints generated during the call are not treated as your answers.'}
            </p>
          </div>
          <button
            type="button"
            className="prep-btn prep-btn-secondary prep-btn-sm"
            onClick={() => void generate(true)}
            disabled={analyzing || !session}
          >
            <RefreshCw size={14} className={analyzing ? 'animate-spin' : ''} />
            {analyzing ? (ru ? 'Разбираю…' : 'Analyzing…') : ru ? 'Пересобрать разбор' : 'Rebuild review'}
          </button>
        </header>

        {loading && <div className="prep-preview-card mt-5 prep-faint">{ru ? 'Загружаю сессию…' : 'Loading session…'}</div>}
        {error && (
          <div className="growth-error mt-5" role="alert">
            <TriangleAlert size={20} />
            <div><strong>{ru ? 'Не удалось собрать разбор' : 'Could not build review'}</strong><p>{error}</p></div>
          </div>
        )}

        {session && (
          <section className="prep-preview-card mt-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <strong>{session.title || (ru ? 'Интервью' : 'Interview')}</strong>
              <p className="prep-faint mt-1">{new Date(session.started_at).toLocaleString(ru ? 'ru-RU' : 'en-US')}</p>
            </div>
            <p className="prep-faint">
              {session.transcripts.filter((line) => line.speaker === 'me').length} {ru ? 'ваших реплик' : 'of your lines'} ·{' '}
              {reviews.length} {ru ? 'разобранных ответов' : 'reviewed answers'}
            </p>
          </section>
        )}

        {analyzing && !analysis && (
          <div className="prep-preview-card mt-4 flex items-center gap-3">
            <RefreshCw size={18} className="animate-spin" />
            <div><strong>{ru ? 'Сопоставляю вопросы с вашими ответами' : 'Pairing questions with your answers'}</strong><p className="prep-faint mt-1">{ru ? 'Ищу конкретные ошибки, пробелы и подтверждённые навыки.' : 'Finding concrete errors, gaps, and demonstrated skills.'}</p></div>
          </div>
        )}

        {analysis && (
          <>
            <section className="mt-5 grid gap-4 md:grid-cols-[1.4fr_.6fr]">
              <div className="prep-preview-card">
                <p className="prep-eyebrow">{ru ? 'ВЫВОД' : 'CONCLUSION'}</p>
                <p className="mt-2 text-[15px] leading-relaxed">{analysis.conclusion}</p>
              </div>
              <div className="prep-preview-card">
                <p className="prep-eyebrow">{ru ? 'ОЦЕНКА ПО ОТВЕТАМ' : 'ANSWER SCORE'}</p>
                <strong className="mt-2 block text-3xl" style={{ color: scoreColor(analysis.overallScore) }}>{analysis.overallScore}/100</strong>
                <p className="prep-faint mt-1">{analysis.overallLevel} · {ru ? 'уверенность' : 'confidence'} {Math.round(analysis.overallConfidence * 100)}%</p>
              </div>
            </section>

            <section className="mt-6">
              <div className="mb-3">
                <p className="prep-eyebrow">{ru ? 'ВОПРОС → ВАШ ОТВЕТ → ОБРАТНАЯ СВЯЗЬ' : 'QUESTION → YOUR ANSWER → FEEDBACK'}</p>
                <h2 className="prep-h2 mt-1">{ru ? 'Разбор по вопросам' : 'Answer-by-answer review'}</h2>
              </div>
              {reviews.length === 0 ? (
                <div className="prep-empty-state">
                  <p className="prep-h2">{ru ? 'Не удалось надёжно выделить пары вопрос–ответ' : 'No reliable question-answer pairs found'}</p>
                  <p className="prep-sub mt-1">{ru ? 'Транскрипт остаётся ниже — его можно проверить вручную.' : 'You can still inspect the transcript below.'}</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {reviews.map((review, index) => (
                    <article key={`${review.question}-${index}`} className="prep-answer-review p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="prep-eyebrow">{review.topic}</p>
                          <h3 className="mt-1 text-[16px] font-semibold leading-snug">{review.question}</h3>
                        </div>
                        <strong style={{ color: scoreColor(review.score) }}>{review.score}/100</strong>
                      </div>
                      <div className="mt-4 rounded-xl border border-[var(--prep-line)] bg-[var(--prep-surface-soft)] p-4">
                        <p className="prep-eyebrow">{ru ? 'ЧТО ВЫ СКАЗАЛИ' : 'WHAT YOU SAID'}</p>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{review.candidateAnswer}</p>
                      </div>
                      <div className="mt-4 grid gap-3 lg:grid-cols-2">
                        {review.whatWasGood.length > 0 && (
                          <div className="rounded-xl border border-[var(--prep-line)] p-4">
                            <h4 className="flex items-center gap-2 font-semibold"><CheckCircle2 size={16} style={{ color: 'var(--prep-green)' }} />{ru ? 'Что получилось' : 'What worked'}</h4>
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{review.whatWasGood.map((item) => <li key={item}>{item}</li>)}</ul>
                          </div>
                        )}
                        {(review.problems.length > 0 || review.missingPoints.length > 0) && (
                          <div className="rounded-xl border border-[var(--prep-line)] p-4">
                            <h4 className="flex items-center gap-2 font-semibold"><XCircle size={16} style={{ color: 'var(--prep-red)' }} />{ru ? 'Ошибки и пробелы' : 'Errors and gaps'}</h4>
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{[...review.problems, ...review.missingPoints].map((item) => <li key={item}>{item}</li>)}</ul>
                          </div>
                        )}
                      </div>
                      <div className="mt-3 rounded-xl border border-[var(--prep-line)] p-4">
                        <h4 className="flex items-center gap-2 font-semibold"><Lightbulb size={16} style={{ color: 'var(--prep-amber)' }} />{ru ? 'Как ответить сильнее' : 'A stronger answer'}</h4>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{review.betterAnswer}</p>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            {evidenceLayout.hasAny && (
              <section className={`mt-6 grid gap-4 ${evidenceLayout.isSplit ? 'lg:grid-cols-2' : ''}`}>
                {evidenceLayout.hasStrengths && (
                  <div className="prep-preview-card">
                    <h2 className="prep-h2">{ru ? 'Подтверждённые сильные стороны' : 'Confirmed strengths'}</h2>
                    <ul className="mt-3 space-y-2 text-sm">{analysis.strengths.map((item) => <li key={item.topic}><strong>{item.topic}:</strong> {item.evidence}</li>)}</ul>
                  </div>
                )}
                {evidenceLayout.hasWeaknesses && (
                  <div className="prep-preview-card">
                    <h2 className="prep-h2">{ru ? 'Куда расти дальше' : 'Growth areas'}</h2>
                    <ul className="mt-3 space-y-3 text-sm">{analysis.weaknesses.map((item) => <li key={item.topic}><strong>{item.topic}:</strong> {item.evidence}<p className="prep-faint mt-1">{item.learningAction}</p></li>)}</ul>
                  </div>
                )}
              </section>
            )}
          </>
        )}

        {session && (
          <section className="mt-6 space-y-3 pb-8">
            <details className="prep-preview-card">
              <summary className="cursor-pointer font-semibold">{ru ? 'Полный транскрипт' : 'Full transcript'}</summary>
              <div className="prep-transcript-review mt-4">
                {session.transcripts.map((line, index) => <p key={`${line.ts}-${index}`}><span>{line.speaker === 'me' ? (ru ? 'Вы' : 'You') : (ru ? 'Интервьюер' : 'Interviewer')}:</span> {line.text}</p>)}
              </div>
            </details>
            {session.answers.length > 0 && (
              <details className="prep-preview-card">
                <summary className="cursor-pointer font-semibold">{ru ? 'Подсказки ИИ во время созвона — не учитываются в оценке' : 'AI hints during the call — excluded from assessment'}</summary>
                <div className="mt-4 space-y-3">{session.answers.map((answer) => <article key={answer.id} className="prep-answer-review"><p className="prep-answer-question">{answer.question}</p><p className="prep-answer-text">{answer.spoken || answer.short}</p></article>)}</div>
              </details>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
