import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnswerPanel from '../components/interview/AnswerPanel';
import FastAnswerToggle from '../components/interview/FastAnswerToggle';
import LiveStatusBar, { type LiveTone } from '../components/interview/LiveStatusBar';
import { AnswerTab } from '../components/interview/AnswerTabs';
import InterviewCockpitShell from '../components/interview/InterviewCockpitShell';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import InterviewInlineAlert from '../components/interview/InterviewInlineAlert';
import InterviewTranscriptPanel from '../components/interview/InterviewTranscriptPanel';
import ManualQuestionBox from '../components/interview/ManualQuestionBox';
import { buildCopilotSessionExport } from '../lib/interviewSessionExport';
import { pipelineToStreamOpts, type AnswerRevisionMode, type PipelineStreamInput } from '../lib/answerRevision';
import { debugInfoToPipeline } from '../lib/interviewStreamHelpers';
import { useAnswerRevision } from '../hooks/useAnswerRevision';
import { useApp } from '../context/AppContext';
import { useLiveCopilot } from '../hooks/useLiveCopilot';
import { useLiveCopilotPrefs } from '../hooks/useLiveCopilotPrefs';
import { useManualInterviewAsk } from '../hooks/useManualInterviewAsk';
import { playAnswerChime } from '../lib/notifySound';
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

/** Calm full-screen reading overlay for the live answer (Focus mode). */
function FocusOverlay({
  statusLabel,
  question,
  answer,
  onExit,
}: {
  statusLabel: string;
  question: string;
  answer: string;
  onExit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-surface/95 px-8 backdrop-blur-md">
      <div className="absolute right-5 top-5">
        <button type="button" onClick={onExit} className="btn-secondary btn-sm">
          Exit <span className="cockpit-kbd">Esc</span>
        </button>
      </div>
      <div className="w-full max-w-3xl">
        <div className="mb-5 flex items-center gap-2 text-xs">
          <span className="sc-dot sc-dot--live" />
          <span className="text-ink-muted">{statusLabel}</span>
        </div>
        {question && <p className="mb-5 text-lg font-medium text-emerald-400">{question}</p>}
        <p className="whitespace-pre-wrap text-[26px] leading-[1.5] text-ink">
          {answer || 'Слушаю вопрос…'}
        </p>
      </div>
    </div>
  );
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
  const [focusMode, setFocusMode] = useState(false);
  const [manualSessionStartedAt, setManualSessionStartedAt] = useState<number | null>(null);

  const {
    sources,
    mode,
    language,
    audioRate,
    sttOptions,
    toggleSource,
    setMode,
    setLanguage,
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

  // Focus mode: toggled from the title-bar button; Esc closes it.
  useEffect(() => {
    const toggle = () => setFocusMode((v) => !v);
    window.addEventListener('skillcue:toggle-focus', toggle);
    return () => window.removeEventListener('skillcue:toggle-focus', toggle);
  }, []);
  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocusMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode]);

  // Tell the sidebar a session is live (breathing dot on the nav row).
  useEffect(() => {
    window.dispatchEvent(new Event(active ? 'skillcue:live-start' : 'skillcue:live-stop'));
  }, [active]);

  // Opt-in chime the moment an answer starts streaming (first token).
  const prevStreamRef = useRef(false);
  useEffect(() => {
    const has = displayStream.trim().length > 0;
    if (has && !prevStreamRef.current) playAnswerChime();
    prevStreamRef.current = has;
  }, [displayStream]);

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

  const dbg = active ? sttDebug : (manualDebug ?? sttDebug);
  const sttMs = dbg?.timeToFinalMs;
  const llmMs = dbg?.timeToAnswerMs;
  const totalMs = sttMs != null && llmMs != null ? sttMs + llmMs : undefined;
  const tone: LiveTone = isGenerating
    ? 'processing'
    : active
      ? 'listening'
      : hasAnswer
        ? 'ready'
        : 'idle';
  const statusLabel = streaming
    ? 'Answering'
    : isGenerating
      ? 'Transcribing'
      : active
        ? 'Listening'
        : hasAnswer
          ? 'Answer ready'
          : 'Idle';
  const flowStep = streaming ? 2 : isGenerating ? 1 : active ? 0 : -1;
  const focusAnswer = displayStream || history[history.length - 1]?.spoken || '';

  return (
    <InterviewCockpitShell>
      <LiveStatusBar
        active={active}
        statusLabel={statusLabel}
        tone={tone}
        flowStep={flowStep}
        sttMs={sttMs}
        llmMs={llmMs}
        totalMs={totalMs}
        sources={sources}
        mode={mode}
        language={language}
        audioRate={audioRate}
        canStart={hasAnyKey}
        hasStt={hasStt}
        noSource={noSource}
        onToggleSource={toggleSource}
        onModeChange={setMode}
        onLanguageChange={setLanguage}
        onAudioRateChange={setAudioRate}
        onStart={handleStart}
        onStop={() => void stop()}
        utilities={
          <>
            <FastAnswerToggle />
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
          </>
        }
      />

      {!hasAnyKey && (
        <InterviewInlineAlert tone="warn">
          Add an API key in Settings to enable live answers.
        </InterviewInlineAlert>
      )}

      {!hasStt && (
        <InterviewInlineAlert tone="info">
          Local transcription needs a speech model. Open Settings → Speech Recognition to download
          one. Manual input works without it.
        </InterviewInlineAlert>
      )}

      {isElectron && sources.mic && !sources.system && (
        <InterviewInlineAlert tone="warn">
          Enable System audio — answers are built from the interviewer&apos;s questions, not your mic.
        </InterviewInlineAlert>
      )}

      {error && <InterviewInlineAlert tone="error">{error}</InterviewInlineAlert>}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(330px,400px)_1fr]">
        <InterviewTranscriptPanel
          lines={lines}
          debug={dbg}
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

      {focusMode && (
        <FocusOverlay
          statusLabel={statusLabel}
          question={activeQuestion}
          answer={focusAnswer}
          onExit={() => setFocusMode(false)}
        />
      )}
    </InterviewCockpitShell>
  );
}
