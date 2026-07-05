import { useEffect, useRef, useState } from 'react';
import { topicStatusFromScore, topicStatusTone } from '../../lib/vacancyReview/readiness';
import { useVoiceAnswer } from '../../lib/vacancyReview/useVoiceAnswer';
import { MAX_DRILL_DEPTH, drillDepth } from '../../lib/vacancyReview/vacancyReviewService';
import type { Difficulty, QuestionLevel, SmokeReviewSession } from '../../lib/vacancyReview/types';

/** Same thresholds as the readiness map, so scores read identically everywhere. */
function scoreColor(value: number): string {
  return `var(--prep-${topicStatusTone(topicStatusFromScore(value))})`;
}

interface Props {
  session: SmokeReviewSession;
  evaluating?: boolean;
  onSubmitAnswer: (text: string, source: 'voice' | 'text', skipped?: boolean) => void;
  onNext: () => void;
  onFinish: () => void;
  /** Дожим: вставить уточняющий вопрос интервьюера следующим и перейти к нему. */
  onAskFollowUp?: (text: string) => void;
}

const DIFF_TONE: Record<Difficulty, string> = {
  easy: 'prep-tone-green',
  medium: 'prep-tone-blue',
  hard: 'prep-tone-amber',
};

const DIFF_LABEL: Record<Difficulty, string> = {
  easy: 'лёгкий',
  medium: 'средний',
  hard: 'сложный',
};

const LEVEL_LABEL: Record<QuestionLevel, string> = {
  junior: 'Junior',
  middle: 'Middle',
  senior: 'Senior',
  lead: 'Lead',
};

export default function SmokeInterviewView({
  session,
  evaluating = false,
  onSubmitAnswer,
  onNext,
  onFinish,
  onAskFollowUp,
}: Props) {
  const { questions, currentIndex, vacancyAnalysis } = session;
  const question = questions[currentIndex];
  const existing = session.answers.find((a) => a.questionId === question?.id);
  const [text, setText] = useState(existing?.text ?? '');

  useEffect(() => {
    setText(existing?.text ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex]);

  const voice = useVoiceAnswer((t) => setText(t), vacancyAnalysis.language);

  // Таймер ответа: лёгкое давление времени, как на реальном интервью.
  // Стартует при показе вопроса, замирает после оценки.
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    setElapsedS(0);
    if (existing) return;
    const startedAt = Date.now();
    const t = setInterval(() => setElapsedS(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, Boolean(existing)]);

  // Оценка появляется НИЖЕ карточки вопроса — доводим пользователя до неё,
  // иначе на небольшом экране легко не заметить, что ответ уже разобран.
  const evalRef = useRef<HTMLDivElement | null>(null);
  const wasEvaluating = useRef(false);
  const currentEvaluation = existing?.evaluation;
  useEffect(() => {
    if (wasEvaluating.current && !evaluating && currentEvaluation) {
      evalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    wasEvaluating.current = evaluating;
  }, [evaluating, currentEvaluation]);

  if (!question) return null;
  const topic = vacancyAnalysis.interviewTopics.find((t) => t.id === question.topicId);
  const evaluation = existing?.evaluation;
  const answered = Boolean(existing);
  const isLast = currentIndex === questions.length - 1;
  // Дожим доступен, пока по этому вопросу не дожимали и цепочка не упёрлась в
  // потолок (вопрос → дожим → дожим, как у живого интервьюера).
  const canDrill =
    Boolean(onAskFollowUp) &&
    !questions.some((q) => q.parentQuestionId === question.id) &&
    drillDepth(question, questions) < MAX_DRILL_DEPTH;
  const progress = Math.round(((currentIndex + (answered ? 1 : 0)) / questions.length) * 100);
  const canEvaluate = text.trim().length >= 2 && !evaluating;
  const submitCurrentAnswer = () => {
    const voiceText = voice.stop();
    onSubmitAnswer(voiceText || text, voice.recording ? 'voice' : 'text');
  };

  return (
    <div className="prep-rise grid gap-5 lg:grid-cols-[1fr_240px]">
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="prep-faint">
              Вопрос {currentIndex + 1} из {questions.length}
              {!answered && elapsedS >= 5 && (
                <span
                  title="Время на этот ответ. На реальном интервью 2–3 минуты — норма."
                  style={elapsedS >= 180 ? { color: 'var(--prep-amber)' } : undefined}
                >
                  {' '}
                  · ⏱ {Math.floor(elapsedS / 60)}:{String(elapsedS % 60).padStart(2, '0')}
                </span>
              )}
            </p>
            <div className="flex gap-1.5">
              {question.isFollowUp && <span className="prep-chip prep-tone-amber">Дожим</span>}
              <span className="prep-chip prep-tone-violet">{topic?.title}</span>
              {question.level && (
                <span className="prep-chip prep-tone-blue">{LEVEL_LABEL[question.level]}</span>
              )}
              <span className={`prep-chip ${DIFF_TONE[question.difficulty]}`}>
                {DIFF_LABEL[question.difficulty]}
              </span>
            </div>
          </div>
          <div className="prep-bar prep-bar-green mt-2">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="prep-card prep-card-pad">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[17px] font-semibold leading-snug" style={{ color: 'var(--prep-ink)' }}>
              {question.question}
            </p>
            <SpeakButton text={question.question} lang={vacancyAnalysis.language} />
          </div>

          {question.whyAsked && (
            <p className="prep-faint mt-2">Зачем спрашивают: {question.whyAsked}</p>
          )}

          {question.expectedAnswerPoints && question.expectedAnswerPoints.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12.5px] font-bold" style={{ color: 'var(--prep-green)' }}>
                Что хочет услышать интервьюер
              </summary>
              <ul className="mt-1.5 space-y-1 pl-1">
                {question.expectedAnswerPoints.map((p) => (
                  <li key={p} className="prep-sub flex gap-2">
                    <span style={{ color: 'var(--prep-green)' }}>•</span>
                    {p}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <textarea
            className="prep-textarea mt-3"
            style={{ minHeight: 150 }}
            placeholder="Ответьте голосом или исправьте текст перед оценкой…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={answered}
          />

          {!answered && (
            <div className={`prep-voice-strip mt-3 ${voice.recording ? 'is-recording' : ''}`}>
              <span className="prep-voice-dot" />
              <div className="min-w-0 flex-1">
                <p>{voice.recording ? 'Идёт запись ответа' : 'Голосовой ответ'}</p>
                <span>
                  {voice.error
                    ? voice.error
                    : voice.recording
                      ? 'Говорите как на интервью. После остановки SkillCue оценит очищенный текст.'
                      : 'Можно ответить голосом или вставить текст вручную.'}
                </span>
              </div>
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!answered ? (
              <>
                <button
                  type="button"
                  className="prep-btn"
                  disabled={voice.recording ? evaluating : !canEvaluate}
                  onClick={submitCurrentAnswer}
                >
                  {evaluating
                    ? 'Оцениваю…'
                    : voice.recording
                      ? 'Остановить и оценить'
                      : 'Оценить ответ'}
                </button>
                <button
                  type="button"
                  className={`prep-btn-sm ${voice.recording ? 'prep-btn' : 'prep-btn-ghost'}`}
                  onClick={voice.toggle}
                  title="Ответить голосом"
                >
                  {voice.recording ? 'Пауза записи' : 'Начать запись голосом'}
                </button>
              </>
            ) : (
              <>
                {isLast ? (
                  <button type="button" className="prep-btn" onClick={onFinish}>
                    Завершить разбор
                  </button>
                ) : (
                  <button type="button" className="prep-btn" onClick={onNext}>
                    Следующий вопрос
                  </button>
                )}
              </>
            )}
            <span className="flex-1" />
            {/* Пропуск — не соседняя кнопка с «Оценить», а тихая ссылка справа. */}
            {!answered && (
              <button
                type="button"
                className="prep-link-btn"
                onClick={() => {
                  voice.stop();
                  onSubmitAnswer('', 'text', true);
                }}
              >
                Пропустить вопрос
              </button>
            )}
            {!(answered && isLast) && (
              <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onFinish}>
                Завершить досрочно
              </button>
            )}
          </div>
        </div>

        {evaluation && (
          <div ref={evalRef} className="prep-card prep-card-pad space-y-3">
            {evaluation.evaluationSource === 'heuristic' && (
              <p
                className="rounded-md px-3 py-2 text-[12.5px] font-semibold"
                style={{ background: 'color-mix(in srgb, var(--prep-amber) 14%, transparent)', color: 'var(--prep-amber)' }}
              >
                ⚠ Приблизительная локальная оценка — AI не подключён. Проценты ориентировочные,
                полноценный разбор появится после подключения ключа в настройках.
              </p>
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="prep-h2">Оценка ответа</p>
                {evaluation.verdict && <p className="prep-sub mt-0.5">{evaluation.verdict}</p>}
              </div>
              <div className="shrink-0 text-right">
                <span
                  className="text-[26px] font-bold leading-none"
                  style={{ color: scoreColor(evaluation.score) }}
                >
                  {evaluation.score}%
                </span>
                {evaluation.levelEstimate && (
                  <p className="mt-1">
                    <span className="prep-chip prep-tone-violet">
                      Звучит как {LEVEL_LABEL[evaluation.levelEstimate]}
                    </span>
                  </p>
                )}
              </div>
            </div>

            {/* Эвристическая «сильная версия» — шаблон, не привязанный к вопросу;
                без AI она вводит в заблуждение, поэтому показываем только AI-версию. */}
            {evaluation.suggestedBetterAnswer && evaluation.evaluationSource !== 'heuristic' && (
              <div className="prep-strong-answer">
                <p className="prep-eyebrow">Сильная версия ответа</p>
                <p className="mt-2 whitespace-pre-wrap">{evaluation.suggestedBetterAnswer}</p>
                {evaluation.hallucinationGuard && evaluation.hallucinationGuard.length > 0 && (
                  <p className="mt-2 text-[11.5px]" style={{ color: 'var(--prep-ink-faint)' }}>
                    Без выдумок: {evaluation.hallucinationGuard.join(' · ')}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Metric label="Точность" value={evaluation.technicalAccuracyScore} />
              {typeof evaluation.coverageScore === 'number' && (
                <Metric label="Покрытие темы" value={evaluation.coverageScore} />
              )}
              <Metric label="Конкретика" value={evaluation.specificityScore} />
              <Metric label="Структура" value={evaluation.clarityScore} />
              <Metric label="Уверенность" value={evaluation.confidenceScore} />
              {typeof evaluation.ownershipScore === 'number' && evaluation.ownershipScore > 0 && (
                <Metric label="Роль/ownership" value={evaluation.ownershipScore} />
              )}
            </div>

            <p className="prep-sub">{evaluation.feedback}</p>

            {evaluation.detectedNoiseOrAsrErrors && evaluation.detectedNoiseOrAsrErrors.length > 0 && (
              <div className="text-[12px]" style={{ color: 'var(--prep-ink-faint)' }}>
                <p>
                  🎙 В записи есть шум распознавания речи (не техническая ошибка): «
                  {evaluation.detectedNoiseOrAsrErrors.join(' » · «')}»
                </p>
                {evaluation.normalizedAnswerSummary && (
                  <details className="mt-1">
                    <summary className="cursor-pointer font-semibold" style={{ color: 'var(--prep-green)' }}>
                      Как поняли ваш ответ после очистки от шума
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap">{evaluation.normalizedAnswerSummary}</p>
                  </details>
                )}
              </div>
            )}

            {evaluation.overclaimed && (
              <p className="text-[12.5px] font-semibold" style={{ color: 'var(--prep-red)' }}>
                ⚠ Заявлен опыт, не подтверждённый резюме — лучше честная формулировка.
              </p>
            )}

            {evaluation.extractedValidPoints && evaluation.extractedValidPoints.length > 0 && (
              <FeedbackList
                label="Удалось разобрать из ответа"
                items={evaluation.extractedValidPoints}
                color="var(--prep-ink-muted)"
                mark="»"
              />
            )}

            {evaluation.goodPoints.length > 0 && (
              <FeedbackList label="Сильные стороны" items={evaluation.goodPoints} color="var(--prep-green)" mark="✓" />
            )}
            {evaluation.weakPoints && evaluation.weakPoints.length > 0 && (
              <FeedbackList label="Слабые места" items={evaluation.weakPoints} color="var(--prep-amber)" mark="•" />
            )}
            {evaluation.missingPoints.length > 0 && (
              <FeedbackList label="Обязательно добавить" items={evaluation.missingPoints} color="var(--prep-amber)" mark="+" />
            )}
            {evaluation.technicalCorrections && evaluation.technicalCorrections.length > 0 && (
              <FeedbackList label="Технические правки" items={evaluation.technicalCorrections} color="var(--prep-red)" mark="→" />
            )}

            {evaluation.betterStructure && evaluation.betterStructure.length > 0 && (
              <details>
                <summary className="cursor-pointer text-[12.5px] font-bold" style={{ color: 'var(--prep-green)' }}>
                  Как структурировать ответ
                </summary>
                <ol className="mt-1.5 space-y-1 pl-1">
                  {evaluation.betterStructure.map((s, i) => (
                    <li key={s} className="prep-sub flex gap-2">
                      <span className="font-semibold" style={{ color: 'var(--prep-green)' }}>
                        {i + 1}.
                      </span>
                      {s}
                    </li>
                  ))}
                </ol>
              </details>
            )}

            {evaluation.followUpQuestions && evaluation.followUpQuestions.length > 0 && (
              <div>
                <p
                  className="text-[12px] font-bold uppercase tracking-wide"
                  style={{ color: 'var(--prep-ink-faint)' }}
                >
                  Чем докопается интервьюер
                </p>
                <ul className="mt-1 space-y-1">
                  {evaluation.followUpQuestions.map((fq) => (
                    <li key={fq} className="prep-sub flex items-start gap-2">
                      <span className="shrink-0 font-bold" style={{ color: 'var(--prep-ink-muted)' }}>
                        ?
                      </span>
                      <span className="min-w-0 flex-1">{fq}</span>
                      {canDrill && onAskFollowUp && (
                        <button
                          type="button"
                          className="prep-link-btn shrink-0"
                          onClick={() => onAskFollowUp(fq)}
                          title="Ответить на этот дожим прямо сейчас"
                        >
                          Ответить →
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {canDrill && onAskFollowUp && (
                  <p className="prep-faint mt-1.5">
                    Кликните «Ответить» — дожим станет следующим вопросом и попадёт в отчёт по этой же теме.
                  </p>
                )}
              </div>
            )}

            {evaluation.nextTrainingFocus && (
              <p className="text-[12.5px]" style={{ color: 'var(--prep-ink-muted)' }}>
                <span className="font-bold" style={{ color: 'var(--prep-green)' }}>
                  Что тренировать:{' '}
                </span>
                {evaluation.nextTrainingFocus}
              </p>
            )}
          </div>
        )}
      </div>

      <aside className="prep-card prep-card-pad h-fit">
        <p className="prep-faint">Темы вакансии</p>
        <div className="mt-2 space-y-1.5">
          {vacancyAnalysis.interviewTopics.map((t) => {
            const planned = questions.filter((q) => q.topicId === t.id).length;
            const asked = session.answers.filter(
              (a) => questions.find((q) => q.id === a.questionId)?.topicId === t.id,
            ).length;
            const active = t.id === question.topicId;
            const done = planned > 0 && asked >= planned;
            return (
              <div
                key={t.id}
                className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5"
                style={{ background: active ? 'var(--prep-green-soft)' : 'transparent' }}
              >
                <span className="truncate text-[12.5px]" style={{ color: 'var(--prep-ink-muted)' }}>
                  {t.title}
                </span>
                <span
                  className="prep-faint shrink-0"
                  title="Отвечено / запланировано вопросов по теме"
                  style={done ? { color: 'var(--prep-green)' } : undefined}
                >
                  {done ? '✓ ' : ''}
                  {asked}/{planned}
                </span>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

/**
 * Озвучка вопроса системным голосом (Web Speech API) — тренировка на слух,
 * как на реальном интервью. Кнопка прячется, если синтез речи недоступен.
 */
function SpeakButton({ text, lang }: { text: string; lang: 'ru' | 'en' }) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    // Смена вопроса или уход со страницы — обрываем озвучку.
    return () => window.speechSynthesis?.cancel();
  }, [text]);

  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;

  const toggle = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang === 'ru' ? 'ru-RU' : 'en-US';
    utter.rate = 1;
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utter);
  };

  return (
    <button
      type="button"
      className="prep-btn-ghost prep-btn-sm shrink-0"
      onClick={toggle}
      title={speaking ? 'Остановить озвучку' : 'Озвучить вопрос — как будто его задал интервьюер'}
    >
      {speaking ? '■ Стоп' : '🔊 Озвучить'}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-[12px]" style={{ color: 'var(--prep-ink-faint)' }}>
      {label}{' '}
      <strong style={{ color: scoreColor(value) }}>{value}</strong>
    </span>
  );
}

function FeedbackList({
  label,
  items,
  color,
  mark,
}: {
  label: string;
  items: string[];
  color: string;
  mark: string;
}) {
  return (
    <div>
      <p className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--prep-ink-faint)' }}>
        {label}
      </p>
      <ul className="mt-1 space-y-1">
        {items.map((it) => (
          <li key={it} className="prep-sub flex gap-2">
            <span className="shrink-0 font-bold" style={{ color }}>
              {mark}
            </span>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
