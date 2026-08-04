import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Clock3,
  LoaderCircle,
  Mic,
  MoreHorizontal,
  RefreshCw,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { useQuestionSpeech } from '../../hooks/useQuestionSpeech';
import { topicStatusFromScore, topicStatusTone } from '../../lib/vacancyReview/readiness';
import { useVoiceAnswer } from '../../lib/vacancyReview/useVoiceAnswer';
import { resolveVoiceAnswerSubmission } from '../../lib/voiceAnswerSubmission';
import { MAX_DRILL_DEPTH, drillDepth } from '../../lib/vacancyReview/vacancyReviewService';
import { useI18n, type I18nKey } from '../../lib/i18n';
import type { Difficulty, QuestionLevel, SmokeReviewSession } from '../../lib/vacancyReview/types';

function scoreColor(value: number): string {
  return `var(--prep-${topicStatusTone(topicStatusFromScore(value))})`;
}

interface Props {
  session: SmokeReviewSession;
  evaluating?: boolean;
  onSubmitAnswer: (text: string, source: 'voice' | 'text', skipped?: boolean) => void;
  onNext: () => void;
  onFinish: () => void;
  onAskFollowUp?: (text: string) => void;
}

const DIFF_TONE: Record<Difficulty, string> = {
  easy: 'prep-tone-green',
  medium: 'prep-tone-blue',
  hard: 'prep-tone-amber',
};

const DIFF_KEY: Record<Difficulty, I18nKey> = {
  easy: 'prep.diff.easy',
  medium: 'prep.diff.medium',
  hard: 'prep.diff.hard',
};

const LEVEL_KEY: Record<QuestionLevel, I18nKey> = {
  junior: 'prep.seniority.junior',
  middle: 'prep.seniority.middle',
  senior: 'prep.seniority.senior',
  lead: 'prep.seniority.lead',
};

export default function SmokeInterviewView({
  session,
  evaluating = false,
  onSubmitAnswer,
  onNext,
  onFinish,
  onAskFollowUp,
}: Props) {
  const { t } = useI18n();
  const { hasAnyKey, backendOnline, hasStt } = useApp();
  const { questions, currentIndex, vacancyAnalysis } = session;
  const question = questions[currentIndex];
  const existing = session.answers.find((answer) => answer.questionId === question?.id);
  const [text, setText] = useState(existing?.text ?? '');

  useEffect(() => {
    setText(existing?.text ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex]);

  const voice = useVoiceAnswer((voiceText) => setText(voiceText), {
    language: vacancyAnalysis.language,
    question: question?.question ?? '',
    topicLabels: vacancyAnalysis.interviewTopics
      .filter((item) => item.id === question?.topicId)
      .map((item) => item.title),
  });
  const [elapsedS, setElapsedS] = useState(0);

  useEffect(() => {
    setElapsedS(0);
    if (existing) return;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedS(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, Boolean(existing)]);

  const evaluationRef = useRef<HTMLDivElement | null>(null);
  const wasEvaluating = useRef(false);
  const currentEvaluation = existing?.evaluation;
  useEffect(() => {
    if (wasEvaluating.current && !evaluating && currentEvaluation) {
      evaluationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    wasEvaluating.current = evaluating;
  }, [evaluating, currentEvaluation]);

  if (!question) return null;

  const topic = vacancyAnalysis.interviewTopics.find((item) => item.id === question.topicId);
  const evaluation = existing?.evaluation;
  const answered = Boolean(existing);
  const isLast = currentIndex === questions.length - 1;
  const canDrill =
    Boolean(onAskFollowUp) &&
    !questions.some((item) => item.parentQuestionId === question.id) &&
    drillDepth(question, questions) < MAX_DRILL_DEPTH;
  const progress = Math.round(((currentIndex + (answered ? 1 : 0)) / questions.length) * 100);
  const canEvaluate = text.trim().length >= 2 && !evaluating && !voice.finalizing;

  const submitCurrentAnswer = async () => {
    if (voice.finalizing) return;
    if (voice.recording) {
      const voiceText = await voice.finish();
      const submission = resolveVoiceAnswerSubmission(voiceText, text);
      if (!submission) return;
      onSubmitAnswer(submission.text, submission.source);
      return;
    }
    if (!text.trim()) return;
    onSubmitAnswer(text, 'text');
  };

  return (
    <div className="prep-rise prep-mock-shell">
      <header className="prep-mock-header">
        <div className="flex min-w-0 items-center gap-3">
          <span className="prep-mock-counter">
            {currentIndex + 1}/{questions.length}
          </span>
          <div className="min-w-0">
            <p className="prep-faint">{vacancyAnalysis.targetRole}</p>
            <strong className="block truncate">{topic?.title}</strong>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!answered && elapsedS >= 5 && (
            <span
              className="prep-mock-timer"
              title={t('prep.smoke.timerTitle')}
              style={elapsedS >= 180 ? { color: 'var(--prep-amber)' } : undefined}
            >
              <Clock3 size={13} aria-hidden="true" />
              {Math.floor(elapsedS / 60)}:{String(elapsedS % 60).padStart(2, '0')}
            </span>
          )}
          {question.isFollowUp && (
            <span className="prep-chip prep-tone-amber">{t('prep.smoke.followUpChip')}</span>
          )}
          <span className={`prep-chip ${DIFF_TONE[question.difficulty]}`}>
            {t(DIFF_KEY[question.difficulty])}
          </span>
        </div>
        <div className="prep-bar prep-bar-green prep-mock-progress">
          <span style={{ width: `${progress}%` }} />
        </div>
      </header>

      <details className="prep-session-topics">
        <summary>
          <span>{t('prep.smoke.sessionTopics')}</span>
          <span>
            {session.answers.length}/{questions.length}
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </summary>
        <div className="prep-session-topics__list">
          {vacancyAnalysis.interviewTopics.map((item) => {
            const planned = questions.filter((candidate) => candidate.topicId === item.id).length;
            const asked = session.answers.filter(
              (answer) =>
                questions.find((candidate) => candidate.id === answer.questionId)?.topicId ===
                item.id,
            ).length;
            const active = item.id === question.topicId;
            const done = planned > 0 && asked >= planned;
            return (
              <div key={item.id} className={active ? 'is-active' : ''}>
                <span className="truncate">{item.title}</span>
                <span title={t('prep.smoke.topicProgressTitle')}>
                  {done && <Check size={12} aria-hidden="true" />}
                  {asked}/{planned}
                </span>
              </div>
            );
          })}
        </div>
      </details>

      <section className="prep-question-card">
        <div className="prep-question-card__heading">
          <div className="min-w-0">
            <p className="prep-eyebrow">
              {t('prep.smoke.question')} {currentIndex + 1}
            </p>
            <h1>{question.question}</h1>
          </div>
          <SpeakButton
            text={question.question}
            nextText={questions[currentIndex + 1]?.question}
            lang={vacancyAnalysis.language}
          />
        </div>

        {(question.whyAsked ||
          (question.expectedAnswerPoints && question.expectedAnswerPoints.length > 0)) && (
          <details className="prep-question-context">
            <summary>
              {t('prep.smoke.questionContext')}
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <div>
              {question.whyAsked && (
                <p>
                  <strong>{t('prep.smoke.whyAsked')}</strong> {question.whyAsked}
                </p>
              )}
              {question.expectedAnswerPoints && question.expectedAnswerPoints.length > 0 && (
                <ul>
                  {question.expectedAnswerPoints.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        )}

        <textarea
          className="prep-textarea prep-answer-textarea"
          aria-label={t('prep.smoke.answerPlaceholder')}
          name="practiceAnswer"
          autoComplete="off"
          placeholder={t('prep.smoke.answerPlaceholder')}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={answered}
        />

        {!answered && (
          <div
            className={`prep-voice-strip ${voice.recording || voice.finalizing ? 'is-recording' : ''}`}
          >
            <span className="prep-voice-dot" />
            <div className="min-w-0 flex-1">
              <p>
                {voice.finalizing
                  ? t('prep.smoke.finalizing')
                  : voice.recording
                    ? t('prep.smoke.recording')
                    : t('prep.smoke.voiceAnswer')}
              </p>
              <span>
                {voice.error
                  ? voice.error
                  : !hasStt
                    ? t('prep.smoke.voiceNotReady')
                    : voice.finalizing
                      ? t('prep.smoke.finalizingHint')
                      : voice.recording
                      ? t('prep.smoke.recordingHint')
                      : t('prep.smoke.voiceHint')}
              </span>
            </div>
          </div>
        )}

        <div className="prep-question-actions">
          {!answered ? (
            <>
              <button
                type="button"
                className="prep-btn"
                onClick={voice.recording ? () => void submitCurrentAnswer() : voice.toggle}
                disabled={evaluating || voice.finalizing || (!hasStt && !voice.recording)}
                title={!hasStt ? t('prep.smoke.voiceNotReady') : t('prep.smoke.voiceAnswerTitle')}
              >
                {voice.finalizing ? (
                  <>{t('prep.smoke.finalizing')}</>
                ) : voice.recording ? (
                  <>
                    <Square size={14} fill="currentColor" aria-hidden="true" />
                    {t('prep.smoke.stopAndScore')}
                  </>
                ) : (
                  <>
                    <Mic size={16} aria-hidden="true" />
                    {t('prep.smoke.startRec')}
                  </>
                )}
              </button>
              <button
                type="button"
                className="prep-btn-secondary prep-btn-sm"
                disabled={!canEvaluate || voice.recording || voice.finalizing}
                onClick={() => void submitCurrentAnswer()}
              >
                {evaluating ? t('prep.smoke.evaluating') : t('prep.smoke.scoreAnswer')}
              </button>
            </>
          ) : isLast ? (
            <button type="button" className="prep-btn" onClick={onFinish}>
              {t('prep.smoke.finishReview')}
            </button>
          ) : (
            <button type="button" className="prep-btn" onClick={onNext}>
              {t('prep.smoke.nextQuestion')}
            </button>
          )}

          <span className="flex-1" />
          {!(answered && isLast) && (
            <details className="prep-action-menu">
              <summary aria-label={t('prep.smoke.moreActions')}>
                <MoreHorizontal size={17} aria-hidden="true" />
              </summary>
              <div>
                {!answered && (
                  <button
                    type="button"
                    disabled={voice.finalizing}
                    onClick={() => {
                      if (voice.finalizing) return;
                      voice.stop();
                      onSubmitAnswer('', 'text', true);
                    }}
                  >
                    {t('prep.smoke.skipQuestion')}
                  </button>
                )}
                <button type="button" disabled={voice.finalizing} onClick={onFinish}>
                  {t('prep.smoke.finishEarly')}
                </button>
              </div>
            </details>
          )}
        </div>
      </section>

      {evaluation && (
        <section ref={evaluationRef} className="prep-evaluation-card">
          {evaluation.evaluationSource === 'heuristic' && (
            <p className="prep-evaluation-warning">
              {!backendOnline
                ? t('prep.smoke.heuristic.backend')
                : !hasAnyKey
                  ? t('prep.smoke.heuristic.noKey')
                  : evaluation.evaluationError === 'timeout'
                    ? t('prep.smoke.heuristic.timeout')
                    : evaluation.evaluationError === 'quota'
                      ? t('prep.smoke.heuristic.quota')
                      : t('prep.smoke.heuristic.generic')}
            </p>
          )}

          <div className="prep-evaluation-heading">
            <div className="min-w-0">
              <p className="prep-eyebrow">{t('prep.smoke.answerEval')}</p>
              {evaluation.verdict && <h2>{evaluation.verdict}</h2>}
            </div>
            <div className="prep-evaluation-score">
              <strong style={{ color: scoreColor(evaluation.score) }}>{evaluation.score}%</strong>
              {evaluation.levelEstimate && (
                <span>
                  {t('prep.smoke.soundsLike')} {t(LEVEL_KEY[evaluation.levelEstimate])}
                </span>
              )}
            </div>
          </div>

          {evaluation.suggestedBetterAnswer && evaluation.evaluationSource !== 'heuristic' && (
            <div className="prep-strong-answer">
              <p className="prep-eyebrow">{t('prep.smoke.strongVersion')}</p>
              <p className="mt-2 whitespace-pre-wrap">{evaluation.suggestedBetterAnswer}</p>
              {evaluation.hallucinationGuard && evaluation.hallucinationGuard.length > 0 && (
                <small>
                  {t('prep.smoke.noFiction')} {evaluation.hallucinationGuard.join(' · ')}
                </small>
              )}
            </div>
          )}

          <p className="prep-sub">{evaluation.feedback}</p>

          {evaluation.nextTrainingFocus && (
            <div className="prep-training-focus">
              <strong>{t('prep.smoke.trainWhat')}</strong>
              <span>{evaluation.nextTrainingFocus}</span>
            </div>
          )}

          {evaluation.followUpQuestions && evaluation.followUpQuestions.length > 0 && (
            <div className="prep-follow-ups">
              <p className="prep-faint">{t('prep.smoke.interviewerDrill')}</p>
              {evaluation.followUpQuestions.map((followUp) => (
                <div key={followUp}>
                  <span>{followUp}</span>
                  {canDrill && onAskFollowUp && (
                    <button
                      type="button"
                      className="prep-link-btn"
                      onClick={() => onAskFollowUp(followUp)}
                      title={t('prep.smoke.answerDrillTitle')}
                    >
                      {t('prep.smoke.answerArrow')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <details className="prep-feedback-details">
            <summary>
              {t('prep.smoke.detailedFeedback')}
              <ChevronDown size={15} aria-hidden="true" />
            </summary>
            <div className="prep-feedback-details__body">
              <div className="prep-metrics">
                <Metric
                  label={t('prep.metric.accuracy')}
                  value={evaluation.technicalAccuracyScore}
                />
                {typeof evaluation.coverageScore === 'number' && (
                  <Metric label={t('prep.metric.coverage')} value={evaluation.coverageScore} />
                )}
                <Metric
                  label={t('prep.metric.specifics')}
                  value={evaluation.specificityScore}
                />
                <Metric label={t('prep.metric.structure')} value={evaluation.clarityScore} />
                <Metric
                  label={t('prep.metric.confidence')}
                  value={evaluation.confidenceScore}
                />
                {typeof evaluation.ownershipScore === 'number' &&
                  evaluation.ownershipScore > 0 && (
                    <Metric
                      label={t('prep.metric.ownership')}
                      value={evaluation.ownershipScore}
                    />
                  )}
              </div>

              {evaluation.detectedNoiseOrAsrErrors &&
                evaluation.detectedNoiseOrAsrErrors.length > 0 && (
                  <div className="prep-noise-note">
                    <p>
                      {t('prep.smoke.noisePre')} «
                      {evaluation.detectedNoiseOrAsrErrors.join(' » · «')}»
                    </p>
                    {evaluation.normalizedAnswerSummary && (
                      <p className="mt-1 whitespace-pre-wrap">
                        {t('prep.smoke.howUnderstood')}: {evaluation.normalizedAnswerSummary}
                      </p>
                    )}
                  </div>
                )}

              {evaluation.overclaimed && (
                <p className="prep-overclaim">{t('prep.smoke.overclaimed')}</p>
              )}
              {evaluation.extractedValidPoints &&
                evaluation.extractedValidPoints.length > 0 && (
                  <FeedbackList
                    label={t('prep.smoke.parsed')}
                    items={evaluation.extractedValidPoints}
                    color="var(--prep-ink-muted)"
                    mark="›"
                  />
                )}
              {evaluation.goodPoints.length > 0 && (
                <FeedbackList
                  label={t('history.mock.strengths')}
                  items={evaluation.goodPoints}
                  color="var(--prep-green)"
                  mark="✓"
                />
              )}
              {evaluation.weakPoints && evaluation.weakPoints.length > 0 && (
                <FeedbackList
                  label={t('history.mock.weakAreas')}
                  items={evaluation.weakPoints}
                  color="var(--prep-amber)"
                  mark="•"
                />
              )}
              {evaluation.missingPoints.length > 0 && (
                <FeedbackList
                  label={t('prep.smoke.mustAdd')}
                  items={evaluation.missingPoints}
                  color="var(--prep-amber)"
                  mark="+"
                />
              )}
              {evaluation.technicalCorrections &&
                evaluation.technicalCorrections.length > 0 && (
                  <FeedbackList
                    label={t('prep.smoke.techCorrections')}
                    items={evaluation.technicalCorrections}
                    color="var(--prep-red)"
                    mark="→"
                  />
                )}
              {evaluation.betterStructure && evaluation.betterStructure.length > 0 && (
                <div>
                  <p className="prep-faint">{t('prep.smoke.howToStructure')}</p>
                  <ol className="mt-1.5 space-y-1">
                    {evaluation.betterStructure.map((step, index) => (
                      <li key={step} className="prep-sub flex gap-2">
                        <span style={{ color: 'var(--prep-green)' }}>{index + 1}.</span>
                        {step}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </details>
        </section>
      )}
    </div>
  );
}

function SpeakButton({
  text,
  nextText,
  lang,
}: {
  text: string;
  nextText?: string;
  lang: 'ru' | 'en';
}) {
  const { t } = useI18n();
  const questionSpeech = useQuestionSpeech();
  const { prefetch, stop } = questionSpeech;

  useEffect(() => {
    prefetch(nextText, lang);
  }, [lang, nextText, prefetch]);

  useEffect(() => {
    stop();
    return stop;
  }, [lang, stop, text]);

  const toggle = () => {
    if (questionSpeech.state === 'loading' || questionSpeech.state === 'playing') {
      questionSpeech.stop();
      return;
    }
    void questionSpeech.play(text, lang);
  };

  const label =
    questionSpeech.state === 'loading'
      ? t('prep.smoke.speechLoading')
      : questionSpeech.state === 'playing'
        ? t('prep.smoke.speakStop')
        : questionSpeech.state === 'error'
          ? t('prep.smoke.speechRetry')
          : t('prep.smoke.speakTitle');
  return (
    <div className="prep-question-speech">
      <button
        type="button"
        className={`prep-icon-button prep-question-speech__button is-${questionSpeech.state}`}
        onClick={toggle}
        title={label}
        aria-label={label}
        aria-busy={questionSpeech.state === 'loading'}
      >
        {questionSpeech.state === 'loading' ? (
          <LoaderCircle className="prep-question-speech__spinner" size={17} aria-hidden="true" />
        ) : questionSpeech.state === 'playing' ? (
          <VolumeX size={17} aria-hidden="true" />
        ) : questionSpeech.state === 'error' ? (
          <RefreshCw size={16} aria-hidden="true" />
        ) : (
          <Volume2 size={17} aria-hidden="true" />
        )}
      </button>
      <span className="prep-question-speech__source">
        {t(questionSpeech.usedFallback ? 'prep.smoke.localVoice' : 'prep.smoke.aiVoice')}
      </span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span>
      {label}
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
      <p className="prep-faint">{label}</p>
      <ul className="mt-1 space-y-1">
        {items.map((item) => (
          <li key={item} className="prep-sub flex gap-2">
            <span className="shrink-0 font-bold" style={{ color }}>
              {mark}
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
