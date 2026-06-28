import { useEffect, useState } from 'react';
import type { Difficulty, SmokeReviewSession } from '../../lib/vacancyReview/types';

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

  if (!question) return null;
  const topic = vacancyAnalysis.interviewTopics.find((t) => t.id === question.topicId);
  const evaluation = existing?.evaluation;
  const answered = Boolean(existing);
  const isLast = currentIndex === questions.length - 1;
  const progress = Math.round(((currentIndex + (answered ? 1 : 0)) / questions.length) * 100);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_240px]">
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="prep-faint">
              Question {currentIndex + 1} / {questions.length}
            </p>
            <div className="flex gap-1.5">
              <span className="prep-chip prep-tone-violet">{topic?.title}</span>
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

          <textarea
            className="prep-textarea mt-3"
            style={{ minHeight: 150 }}
            placeholder="Ответьте текстом…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={answered}
          />

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {!answered ? (
              <>
                <button
                  type="button"
                  className="prep-btn"
                  disabled={text.trim().length < 2 || evaluating}
                  onClick={() => onSubmitAnswer(text, 'text')}
                >
                  {evaluating ? 'Evaluating…' : 'Submit answer'}
                </button>
                <button
                  type="button"
                  className="prep-btn-ghost prep-btn-sm"
                  title="Voice answer — coming soon"
                  disabled
                >
                  🎙 Voice (soon)
                </button>
                <button
                  type="button"
                  className="prep-btn-ghost prep-btn-sm"
                  onClick={() => onSubmitAnswer('', 'text', true)}
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
          <div className="prep-card prep-card-pad">
            <div className="flex items-center justify-between">
              <p className="prep-h2">Quick evaluation</p>
              <span className="text-[20px] font-bold" style={{ color: 'var(--prep-ink)' }}>
                {evaluation.score}%
              </span>
            </div>
            <p className="prep-sub mt-1.5">{evaluation.feedback}</p>
            {evaluation.goodPoints.length > 0 && (
              <p className="mt-2 text-[12.5px]" style={{ color: 'var(--prep-green)' }}>
                ✓ {evaluation.goodPoints.join(' · ')}
              </p>
            )}
            {evaluation.missingPoints.length > 0 && (
              <p className="mt-1 text-[12.5px]" style={{ color: 'var(--prep-amber)' }}>
                Needs: {evaluation.missingPoints.join(', ')}
              </p>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-[12.5px] font-medium" style={{ color: 'var(--prep-green)' }}>
                Suggested stronger answer
              </summary>
              <p className="prep-sub mt-1.5">{evaluation.suggestedBetterAnswer}</p>
            </details>
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
