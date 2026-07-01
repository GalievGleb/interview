import { useEffect, useState } from 'react';
import { useVoiceAnswer } from '../../lib/vacancyReview/useVoiceAnswer';
import type { Difficulty, QuestionLevel, SmokeReviewSession } from '../../lib/vacancyReview/types';

interface Props {
  session: SmokeReviewSession;
  evaluating?: boolean;
  onSubmitAnswer: (text: string, source: 'voice' | 'text', skipped?: boolean) => void;
  onNext: () => void;
  onFinish: () => void;
}

const DIFF_TONE: Record<Difficulty, string> = {
  easy: 'prep-tone-green',
  medium: 'prep-tone-blue',
  hard: 'prep-tone-amber',
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

  if (!question) return null;
  const topic = vacancyAnalysis.interviewTopics.find((t) => t.id === question.topicId);
  const evaluation = existing?.evaluation;
  const answered = Boolean(existing);
  const isLast = currentIndex === questions.length - 1;
  const progress = Math.round(((currentIndex + (answered ? 1 : 0)) / questions.length) * 100);

  return (
    <div className="prep-rise grid gap-5 lg:grid-cols-[1fr_240px]">
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="prep-faint">
              Question {currentIndex + 1} / {questions.length}
            </p>
            <div className="flex gap-1.5">
              <span className="prep-chip prep-tone-violet">{topic?.title}</span>
              {question.level && (
                <span className="prep-chip prep-tone-blue">{LEVEL_LABEL[question.level]}</span>
              )}
              <span className={`prep-chip ${DIFF_TONE[question.difficulty]}`}>{question.difficulty}</span>
            </div>
          </div>
          <div className="prep-bar prep-bar-green mt-2">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="prep-card prep-card-pad">
          <p className="text-[17px] font-semibold leading-snug" style={{ color: 'var(--prep-ink)' }}>
            {question.question}
          </p>

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
            placeholder="Ответьте текстом…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={answered}
          />

          {!answered && (voice.recording || voice.error) && (
            <p className="mt-1.5 text-[12.5px]" style={{ color: voice.error ? 'var(--prep-red)' : 'var(--prep-green)' }}>
              {voice.error ? voice.error : '● Recording — speak your answer, then Stop or Submit.'}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!answered ? (
              <>
                <button
                  type="button"
                  className="prep-btn"
                  disabled={text.trim().length < 2 || evaluating}
                  onClick={() => {
                    const voiceText = voice.stop();
                    onSubmitAnswer(voiceText || text, voice.recording ? 'voice' : 'text');
                  }}
                >
                  {evaluating ? 'Evaluating…' : 'Submit answer'}
                </button>
                <button
                  type="button"
                  className={`prep-btn-sm ${voice.recording ? 'prep-btn' : 'prep-btn-ghost'}`}
                  onClick={voice.toggle}
                  title="Answer by voice"
                >
                  {voice.recording ? '⏹ Stop recording' : '🎙 Record answer'}
                </button>
                <button
                  type="button"
                  className="prep-btn-ghost prep-btn-sm"
                  onClick={() => {
                    voice.stop();
                    onSubmitAnswer('', 'text', true);
                  }}
                >
                  Skip
                </button>
              </>
            ) : (
              <>
                {isLast ? (
                  <button type="button" className="prep-btn" onClick={onFinish}>
                    Finish review
                  </button>
                ) : (
                  <button type="button" className="prep-btn" onClick={onNext}>
                    Next question
                  </button>
                )}
              </>
            )}
            <span className="flex-1" />
            <button type="button" className="prep-btn-ghost prep-btn-sm" onClick={onFinish}>
              Finish review
            </button>
          </div>
        </div>

        {evaluation && (
          <div className="prep-card prep-card-pad space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="prep-h2">Оценка ответа</p>
                {evaluation.verdict && <p className="prep-sub mt-0.5">{evaluation.verdict}</p>}
              </div>
              <div className="shrink-0 text-right">
                <span className="text-[22px] font-bold leading-none" style={{ color: 'var(--prep-ink)' }}>
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

            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Metric label="Точность" value={evaluation.technicalAccuracyScore} />
              <Metric label="Конкретика" value={evaluation.specificityScore} />
              <Metric label="Структура" value={evaluation.clarityScore} />
              <Metric label="Уверенность" value={evaluation.confidenceScore} />
              {typeof evaluation.ownershipScore === 'number' && evaluation.ownershipScore > 0 && (
                <Metric label="Роль/ownership" value={evaluation.ownershipScore} />
              )}
            </div>

            <p className="prep-sub">{evaluation.feedback}</p>

            {evaluation.detectedNoiseOrAsrErrors && evaluation.detectedNoiseOrAsrErrors.length > 0 && (
              <p className="text-[12px]" style={{ color: 'var(--prep-ink-faint)' }}>
                🎙 В записи есть шум распознавания речи (не техническая ошибка): «
                {evaluation.detectedNoiseOrAsrErrors.join(' » · «')}»
              </p>
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

            <details open>
              <summary className="cursor-pointer text-[12.5px] font-bold" style={{ color: 'var(--prep-green)' }}>
                Сильная версия ответа
              </summary>
              <p className="prep-sub mt-1.5 whitespace-pre-wrap">{evaluation.suggestedBetterAnswer}</p>
              {evaluation.hallucinationGuard && evaluation.hallucinationGuard.length > 0 && (
                <p className="mt-2 text-[11.5px]" style={{ color: 'var(--prep-ink-faint)' }}>
                  Без выдумок: {evaluation.hallucinationGuard.join(' · ')}
                </p>
              )}
            </details>

            {evaluation.followUpQuestions && evaluation.followUpQuestions.length > 0 && (
              <FeedbackList
                label="Чем докопается интервьюер"
                items={evaluation.followUpQuestions}
                color="var(--prep-ink-muted)"
                mark="?"
              />
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
        <p className="prep-faint">Vacancy topics</p>
        <div className="mt-2 space-y-1.5">
          {vacancyAnalysis.interviewTopics.map((t) => {
            const asked = session.answers.filter(
              (a) => questions.find((q) => q.id === a.questionId)?.topicId === t.id,
            ).length;
            const active = t.id === question.topicId;
            return (
              <div
                key={t.id}
                className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5"
                style={{ background: active ? 'var(--prep-green-soft)' : 'transparent' }}
              >
                <span className="truncate text-[12.5px]" style={{ color: 'var(--prep-ink-muted)' }}>
                  {t.title}
                </span>
                <span className="prep-faint shrink-0">{asked}</span>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-[12px]" style={{ color: 'var(--prep-ink-faint)' }}>
      {label}{' '}
      <strong style={{ color: 'var(--prep-ink)' }}>{value}</strong>
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
