import { useCallback, useEffect, useMemo, useState } from 'react';
import AnswerPanel from '../components/interview/AnswerPanel';
import { AnswerTab } from '../components/interview/AnswerTabs';
import InterviewCockpitShell from '../components/interview/InterviewCockpitShell';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import InterviewInlineAlert from '../components/interview/InterviewInlineAlert';
import InterviewTranscriptPanel from '../components/interview/InterviewTranscriptPanel';
import LiveControls from '../components/interview/LiveControls';
import ManualQuestionBox from '../components/interview/ManualQuestionBox';
import PageHeader from '../components/interview/PageHeader';
import { buildCopilotSessionExport } from '../lib/interviewSessionExport';
import { pipelineToStreamOpts, type AnswerRevisionMode, type PipelineStreamInput } from '../lib/answerRevision';
import { debugInfoToPipeline } from '../lib/interviewStreamHelpers';
import { useAnswerRevision } from '../hooks/useAnswerRevision';
import { useApp } from '../context/AppContext';
import { useLiveCopilot } from '../hooks/useLiveCopilot';
import { useLiveCopilotPrefs } from '../hooks/useLiveCopilotPrefs';
import { useManualInterviewAsk } from '../hooks/useManualInterviewAsk';
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
    updateAnswerEntry,
    setLiveAnswerText,
    start,
    stop,
  } = useLiveCopilot();

  const { revise, revising } = useAnswerRevision();
  const [revisionStream, setRevisionStream] = useState('');
  const [debugOpen, setDebugOpen] = useState(false);
  const [tab, setTab] = useState<AnswerTab>('spoken');
  const [manualSessionStartedAt, setManualSessionStartedAt] = useState<number | null>(null);

  const {
    sources,
    mode,
    language,
    sttEngine,
    audioRate,
    sttOptions,
    toggleSource,
    setMode,
    setLanguage,
    setSttEngine,
    setAudioRate,
  } = useLiveCopilotPrefs();

  const {
    question,
    setQuestion,
    manualStream,
    setManualStream,
    manualCurrentQuestion,
    manualHistory,
    setManualHistory,
    manualDebug,
    loading,
    manualError,
    setManualError,
    ask,
  } = useManualInterviewAsk({
    hasSession: !!(sessionStartedAt ?? manualSessionStartedAt),
    onSessionStarted: () => setManualSessionStartedAt(Date.now()),
  });

  const displayStream = active ? revisionStream || streamText : revisionStream || manualStream;
  const history = active ? answerHistory : [...answerHistory, ...manualHistory];
  const activeQuestion = active ? currentQuestion : manualCurrentQuestion;
  const isGenerating = active ? streaming || suggestLoading || revising : loading || revising;

  const runRevision = useCallback(
    (
      questionText: string,
      answer: string,
      revisionMode: AnswerRevisionMode,
      handlers: { onStream: (text: string) => void; onDone: (text: string) => void },
      pipeline?: PipelineStreamInput,
    ) => {
      revise(questionText, answer, revisionMode, pipelineToStreamOpts(questionText, pipeline), {
        onStream: handlers.onStream,
        onDone: handlers.onDone,
        onError: (msg) => {
          setManualError(msg);
          setRevisionStream('');
        },
      });
    },
    [revise, setManualError],
  );

  const handleReviseEntry = useCallback(
    (entryId: string, questionText: string, answer: string, revisionMode: AnswerRevisionMode) => {
      const entry =
        answerHistory.find((item) => item.id === entryId) ??
        manualHistory.find((item) => item.id === entryId);
      if (answerHistory.some((item) => item.id === entryId)) {
        setRevisionStream('');
        runRevision(
          questionText,
          answer,
          revisionMode,
          {
            onStream: setRevisionStream,
            onDone: (text) => {
              updateAnswerEntry(entryId, text);
              setRevisionStream('');
            },
          },
          entry?.pipeline,
        );
        return;
      }
      setManualStream('');
      runRevision(
        questionText,
        answer,
        revisionMode,
        {
          onStream: setManualStream,
          onDone: (text) => {
            setManualHistory((prev) =>
              prev.map((item) => (item.id === entryId ? { ...item, spoken: text } : item)),
            );
            setManualStream('');
          },
        },
        entry?.pipeline,
      );
    },
    [answerHistory, manualHistory, runRevision, setManualHistory, setManualStream, updateAnswerEntry],
  );

  const handleReviseActive = useCallback(
    (questionText: string, answer: string, revisionMode: AnswerRevisionMode) => {
      const pipeline = debugInfoToPipeline(active ? sttDebug : manualDebug);
      if (active) {
        setRevisionStream('');
        runRevision(
          questionText,
          answer,
          revisionMode,
          {
            onStream: setRevisionStream,
            onDone: (text) => {
              setLiveAnswerText(text);
              setRevisionStream('');
            },
          },
          pipeline,
        );
        return;
      }
      setManualStream('');
      runRevision(
        questionText,
        answer,
        revisionMode,
        {
          onStream: setManualStream,
          onDone: (text) => {
            setManualStream(text);
          },
        },
        pipeline,
      );
    },
    [active, manualDebug, runRevision, setLiveAnswerText, setManualStream, sttDebug],
  );

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

  const handleAsk = () => {
    setTab('spoken');
    ask();
  };

  const handleStart = () => {
    void start(sources, sttOptions);
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
        onToggleSource={toggleSource}
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
            revising={revising}
            onReviseEntry={handleReviseEntry}
            onReviseActive={handleReviseActive}
            footer={
              <ManualQuestionBox
                value={question}
                onChange={setQuestion}
                onSubmit={handleAsk}
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
