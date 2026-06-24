import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { SttDebugInfo } from '../components/SttDebugPanel';
import AnswerPanel from '../components/interview/AnswerPanel';
import { AnswerTab } from '../components/interview/AnswerTabs';
import InterviewCockpitShell from '../components/interview/InterviewCockpitShell';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import InterviewInlineAlert from '../components/interview/InterviewInlineAlert';
import InterviewTranscriptPanel from '../components/interview/InterviewTranscriptPanel';
import LiveControls from '../components/interview/LiveControls';
import ManualQuestionBox from '../components/interview/ManualQuestionBox';
import PageHeader from '../components/interview/PageHeader';
import { buildCopilotSessionExport, buildExchangeLatency, buildPipelineFromPrepared } from '../lib/interviewSessionExport';
import { prepareTranscriptForLlm } from '../lib/prepareTranscriptForLlm';

import {

  createEmptySessionContext,

  sanitizeLiveAnswer,

  updateSessionContextAfterAnswer,

  type InterviewSessionContext,

} from '@interview/shared';

import { useApp } from '../context/AppContext';

import { useLiveCopilot, CopilotAnswerEntry, LiveSources } from '../hooks/useLiveCopilot';

import { SttMode } from '../lib/liveSession';

import {

  AudioSampleRateMode,

  SttEngine,

} from '../lib/sttOptions';

import type { LiveSessionStatus } from '../components/ui/StatusBadge';



const isElectron = typeof window !== 'undefined' && !!window.electronAPI;



function deriveLiveStatus(

  active: boolean,

  isGenerating: boolean,

  hasAnswer: boolean,

): LiveSessionStatus {

  if (isGenerating) return 'processing';

  if (hasAnswer && !active) return 'answer_ready';

  if (active) return 'listening';

  return 'idle';

}



export default function InterviewPage() {

  const { hasAnyKey, hasStt } = useApp();

  const {

    active,

    lines,

    answerHistory,

    currentQuestion,

    streamText,

    streaming,

    suggestLoading,

    error,

    sttDebug,
    sessionId,
    sessionStartedAt,
    start,
    stop,
  } = useLiveCopilot();



  const [debugOpen, setDebugOpen] = useState(false);

  const [manualDebug, setManualDebug] = useState<SttDebugInfo | null>(null);

  const [manualHistory, setManualHistory] = useState<CopilotAnswerEntry[]>([]);

  const [manualCurrentQuestion, setManualCurrentQuestion] = useState('');



  const [sources, setSources] = useState<LiveSources>(() => ({

    mic: true,

    system: isElectron,

  }));

  const [mode, setMode] = useState<SttMode>('stable');

  const [language, setLanguage] = useState('ru');

  const [sttEngine, setSttEngine] = useState<SttEngine>('nova3-multi');

  const [audioRate, setAudioRate] = useState<AudioSampleRateMode>('16k');

  const [question, setQuestion] = useState('');

  const [manualStream, setManualStream] = useState('');

  const [tab, setTab] = useState<AnswerTab>('spoken');

  const [loading, setLoading] = useState(false);

  const [manualError, setManualError] = useState('');

  const [manualSessionStartedAt, setManualSessionStartedAt] = useState<number | null>(null);

  const cancelManualRef = useRef<(() => void) | null>(null);
  const manualSessionContextRef = useRef<InterviewSessionContext>(createEmptySessionContext());
  const manualDebugRef = useRef<SttDebugInfo | null>(null);

  useEffect(() => {
    manualDebugRef.current = manualDebug;
  }, [manualDebug]);



  const displayStream = active ? streamText : manualStream;

  const history = active ? answerHistory : [...answerHistory, ...manualHistory];

  const activeQuestion = active ? currentQuestion : manualCurrentQuestion;

  const isGenerating = active ? streaming || suggestLoading : loading;

  const noSource = !sources.mic && !sources.system;

  const hasAnswer = history.length > 0 || !!displayStream;

  const liveStatus = deriveLiveStatus(active, isGenerating, hasAnswer);

  const exportData = useMemo(
    () =>
      buildCopilotSessionExport({
        sessionId,
        startedAt: sessionStartedAt ?? manualSessionStartedAt,
        active,
        transcriptLines: lines,
        exchanges: [...answerHistory, ...manualHistory].sort((a, b) => a.ts - b.ts),
        pending:
          displayStream.trim() || activeQuestion.trim()
            ? {
                question: activeQuestion,
                answer: displayStream,
                source: active ? 'live' : 'manual',
              }
            : null,
      }),
    [
      sessionId,
      sessionStartedAt,
      manualSessionStartedAt,
      active,
      lines,
      answerHistory,
      manualHistory,
      displayStream,
      activeQuestion,
    ],
  );



  useEffect(() => {

    if (history.length > 0) setTab('spoken');

  }, [history.length]);



  const toggle = (key: keyof LiveSources) => setSources((s) => ({ ...s, [key]: !s[key] }));



  const ask = () => {

    if (!question.trim()) return;

    if (!sessionStartedAt && !manualSessionStartedAt) {
      setManualSessionStartedAt(Date.now());
    }

    cancelManualRef.current?.();

    const prepared = prepareTranscriptForLlm(question, manualSessionContextRef.current);

    setLoading(true);

    setManualError('');

    setManualStream('');

    setManualCurrentQuestion(prepared.resolvedQuestion);

    setTab('spoken');



    let text = '';
    const answerStartedAt = performance.now();

    setManualDebug({

      rawTranscript: prepared.rawTranscript,

      glossaryCorrected: prepared.corrected,

      intentCorrected: prepared.intentCorrected,

      correctedTranscript: prepared.intentCorrected,

      resolvedQuestion: prepared.resolvedQuestion,

      previousTopic: manualSessionContextRef.current.lastCanonicalTopic,

      currentCanonicalTopic: prepared.canonicalTopic ?? undefined,

      isFollowUp: prepared.followUp.isFollowUp,

      usedPreviousContext: prepared.followUp.usedPreviousContext,

      wasPreviousTopicUsed: prepared.followUp.wasPreviousTopicUsed,

      followUpReason: prepared.followUp.reason,

      resetPreviousTopic: prepared.followUp.resetPreviousTopic,

      resetPreviousTopicReason: prepared.followUp.resetPreviousTopicReason,

      hallucinationRisk: prepared.followUp.hallucinationRisk,

      resumeFactSource: prepared.answerStrategy.resumeContextLevel,

      corrections: prepared.correction.corrections,

      intentCorrections: prepared.intent.intentCorrections,

      intentConfidence: prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,

      intentReason: prepared.intent.reason,

      ambiguity: prepared.intent.ambiguity,

      questionIntent: prepared.answerStrategy.questionIntent,

      answerStrategy: prepared.answerStrategy.answerStrategy,

      resumeContextUsed: prepared.answerStrategy.resumeContextUsed,

      resumeContextLevel: prepared.answerStrategy.resumeContextLevel,

      resumeContextReason: prepared.answerStrategy.resumeContextReason,

    });

    cancelManualRef.current = api.streamInterview(

      prepared.resolvedQuestion,

      {

        onChunk: (chunk) => {

          text += chunk;

          setManualStream(sanitizeLiveAnswer(text));

          setLoading(false);

        },

        onDone: (spoken) => {

          const cleaned = sanitizeLiveAnswer(spoken);
          const llmLatencyMs = performance.now() - answerStartedAt;
          const pipeline = buildPipelineFromPrepared(prepared, {
            previousTopic: manualSessionContextRef.current.lastCanonicalTopic,
            llmCorrectedTranscript: manualDebugRef.current?.llmCorrectedTranscript,
          });
          const latency = buildExchangeLatency(null, llmLatencyMs);

          manualSessionContextRef.current = updateSessionContextAfterAnswer(

            manualSessionContextRef.current,

            {

              rawQuestion: prepared.rawTranscript,

              correctedQuestion: prepared.corrected,

              intentCorrectedQuestion: prepared.intentCorrected,

              resolvedQuestion: prepared.resolvedQuestion,

              questionIntent: prepared.answerStrategy.questionIntent,

              canonicalTopic: prepared.canonicalTopic,

              answerSummary: cleaned,

              resetPreviousTopic: prepared.followUp.resetPreviousTopic,

            },

          );

          setManualHistory((prev) => [

            ...prev,

            {
              id: crypto.randomUUID(),
              question: prepared.resolvedQuestion,
              spoken: cleaned,
              ts: Date.now(),
              source: 'manual',
              pipeline,
              latency,
            },

          ]);

          setManualStream('');

          setManualCurrentQuestion('');

          setLoading(false);

        },

        onError: (msg) => {

          setManualStream('');

          setManualCurrentQuestion('');

          setManualError(msg);

          setLoading(false);

        },

      },

      {

        rawQuestion: prepared.rawTranscript,

        glossaryCorrected: prepared.corrected,

        intentCorrected: prepared.intentCorrected,

        resolvedQuestion: prepared.resolvedQuestion,

        previousTopic: manualSessionContextRef.current.lastCanonicalTopic,

        isFollowUp: prepared.followUp.isFollowUp,

        usedPreviousContext: prepared.followUp.usedPreviousContext,

        followUpReason: prepared.followUp.reason,

        currentCanonicalTopic: prepared.canonicalTopic ?? undefined,

        ambiguity: prepared.intent.ambiguity,

        corrections: prepared.correction.corrections,

        intentCorrections: prepared.intent.intentCorrections,

        intentConfidence:

          prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,

        intentReason: prepared.intent.reason,

        needsLlmCorrection: prepared.correction.needsLlmCorrection,

        questionIntent: prepared.answerStrategy.questionIntent,

        answerStrategy: prepared.answerStrategy.answerStrategy,

        resumeContextUsed: prepared.answerStrategy.resumeContextUsed,

        resumeContextLevel: prepared.answerStrategy.resumeContextLevel,

        resumeContextReason: prepared.answerStrategy.resumeContextReason,

        suggestUnclearPrefix: prepared.answerStrategy.suggestUnclearPrefix,

        onMeta: (meta) => {

          setManualDebug((prev) => {

            if (!prev) return prev;

            const next = { ...prev };

            const llmText = meta.llm_corrected?.trim();

            if (llmText) {

              next.llmCorrectedTranscript = llmText;

              next.intentCorrected = llmText;

            }

            if (meta.question_intent) next.questionIntent = meta.question_intent;

            if (meta.answer_strategy) next.answerStrategy = meta.answer_strategy;

            if (meta.resume_context_used != null) next.resumeContextUsed = meta.resume_context_used;

            if (meta.resume_context_level) next.resumeContextLevel = meta.resume_context_level;

            if (meta.resume_context_reason) next.resumeContextReason = meta.resume_context_reason;

            return next;

          });

        },

      },

    );

  };



  const handleStart = () => {

    void start(sources, {

      mode,

      language,

      engine: sttEngine,

      audioSampleRate: audioRate,

    });

  };



  const liveHint =
    active && sttDebug?.waitReason && !isGenerating && !displayStream
      ? sttDebug.waitReason
      : undefined;

  return (
    <InterviewCockpitShell>
      <PageHeader
        title="Interview Copilot"
        subtitle="Real-time answers based on your resume and vacancy"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <InterviewExportButtons exportData={exportData} />
            {isElectron ? (
              <button
                type="button"
                onClick={() => void window.electronAPI?.overlay.toggle()}
                className="btn-secondary btn-sm"
              >
                Overlay
                <span className="cockpit-kbd">Ctrl+Shift+H</span>
              </button>
            ) : null}
          </div>
        }
      />

      {!hasAnyKey && (
        <InterviewInlineAlert tone="warn">
          Add an API key in Settings to enable live answers.
        </InterviewInlineAlert>
      )}

      <LiveControls
        active={active}
        status={liveStatus}
        sources={sources}
        mode={mode}
        language={language}
        sttEngine={sttEngine}
        audioRate={audioRate}
        canStart={hasAnyKey}
        hasStt={hasStt}
        noSource={noSource}
        onToggleSource={toggle}
        onModeChange={setMode}
        onLanguageChange={setLanguage}
        onSttEngineChange={setSttEngine}
        onAudioRateChange={setAudioRate}
        onStart={handleStart}
        onStop={() => void stop()}
      />

      {!hasStt && (
        <InterviewInlineAlert tone="info">
          Live transcription uses Deepgram — add a key in Settings. Manual input works without it.
        </InterviewInlineAlert>
      )}

      {isElectron && sources.mic && !sources.system && (
        <InterviewInlineAlert tone="warn">
          Enable System audio — answers are built from the interviewer&apos;s questions, not your mic.
        </InterviewInlineAlert>
      )}

      {error && <InterviewInlineAlert tone="error">{error}</InterviewInlineAlert>}

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <InterviewTranscriptPanel
          lines={lines}
          debug={active ? sttDebug : manualDebug ?? sttDebug}
          debugOpen={debugOpen}
          onDebugToggle={() => setDebugOpen((v) => !v)}
          active={active}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AnswerPanel
            tab={tab}
            onTabChange={setTab}
            history={history}
            activeQuestion={activeQuestion}
            displayStream={displayStream}
            isGenerating={isGenerating}
            status={liveStatus}
            active={active}
            liveHint={liveHint}
            footer={
              <ManualQuestionBox
                value={question}
                onChange={setQuestion}
                onSubmit={ask}
                loading={loading}
                disabled={!hasAnyKey}
                error={manualError}
              />
            }
          />
        </div>
      </div>
    </InterviewCockpitShell>
  );
}


