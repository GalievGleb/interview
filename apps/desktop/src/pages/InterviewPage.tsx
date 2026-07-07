import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AnswerPanel from '../components/interview/AnswerPanel';
import FastAnswerToggle from '../components/interview/FastAnswerToggle';
import SpeculativeToggle from '../components/interview/SpeculativeToggle';
import LiveStatusBar from '../components/interview/LiveStatusBar';
import { deriveLiveState } from '../lib/liveStatus';
import { AnswerTab } from '../components/interview/AnswerTabs';
import InterviewCockpitShell from '../components/interview/InterviewCockpitShell';
import InterviewExportButtons from '../components/interview/InterviewExportButtons';
import InterviewInlineAlert from '../components/interview/InterviewInlineAlert';
import InterviewTranscriptPanel from '../components/interview/InterviewTranscriptPanel';
import ManualQuestionBox from '../components/interview/ManualQuestionBox';
import { api } from '../lib/api';
import { buildCopilotSessionExport } from '../lib/interviewSessionExport';
import { pipelineToStreamOpts, type AnswerRevisionMode, type PipelineStreamInput } from '../lib/answerRevision';
import { debugInfoToPipeline } from '../lib/interviewStreamHelpers';
import { useAnswerRevision } from '../hooks/useAnswerRevision';
import { useApp } from '../context/AppContext';
import { useI18n } from '../lib/i18n';
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
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-surface/95 px-8 backdrop-blur-md">
      <div className="absolute right-5 top-5">
        <button type="button" onClick={onExit} className="btn-secondary btn-sm">
          {t('interview.focus.exit')} <span className="cockpit-kbd">Esc</span>
        </button>
      </div>
      <div className="w-full max-w-3xl">
        <div className="mb-5 flex items-center gap-2 text-xs">
          <span className="sc-dot sc-dot--live" />
          <span className="text-ink-muted">{statusLabel}</span>
        </div>
        {question && <p className="mb-5 text-lg font-medium text-emerald-400">{question}</p>}
        <p className="whitespace-pre-wrap text-[26px] leading-[1.5] text-ink">
          {answer || t('interview.focus.listening')}
        </p>
      </div>
    </div>
  );
}

function ReadinessStrip({
  active,
  hasAnyKey,
  hasStt,
  sttWarm,
  sources,
}: {
  active: boolean;
  hasAnyKey: boolean;
  hasStt: boolean;
  sttWarm: 'warming' | 'ready';
  sources: { mic: boolean; system: boolean };
}) {
  const { t } = useI18n();
  const items = [
    { label: 'LLM', ok: hasAnyKey, detail: hasAnyKey ? t('interview.ready.ok') : t('interview.ready.keyNeeded') },
    {
      label: t('interview.ready.speech'),
      ok: hasStt && sttWarm === 'ready',
      detail: hasStt ? (sttWarm === 'ready' ? t('interview.ready.ok') : t('interview.ready.loading')) : t('interview.ready.noModel'),
    },
    {
      label: t('interview.ready.audio'),
      ok: sources.mic || sources.system,
      detail: sources.system ? t('interview.ready.sysAudio') : sources.mic ? t('interview.ready.micOnly') : t('interview.ready.chooseSource'),
    },
    { label: t('interview.ready.privacy'), ok: true, detail: t('interview.ready.localStt') },
  ];
  const readyCount = items.filter((item) => item.ok).length;
  const ready = readyCount === items.length;

  return (
    <div className="skillcue-readiness">
      <div className="min-w-0">
        <p className="skillcue-readiness__eyebrow">{t('interview.ready.eyebrow')}</p>
        <p className="skillcue-readiness__title">
          {active
            ? t('interview.ready.titleActive')
            : ready
              ? t('interview.ready.titleReady')
              : t('interview.ready.titleSetup')}
        </p>
      </div>
      <div className="skillcue-readiness__items">
        {items.map((item) => (
          <span
            key={item.label}
            className={`skillcue-readiness__item ${
              item.ok ? 'skillcue-readiness__item--ok' : 'skillcue-readiness__item--warn'
            }`}
          >
            <span className="sc-dot" />
            <span>{item.label}</span>
            <span className="skillcue-readiness__detail">{item.detail}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function InterviewPage() {
  const { t } = useI18n();
  const { hasAnyKey, hasStt, license } = useApp();
  // Гейт live: тариф basic и сгоревший trial не стартуют live (сервер дублирует).
  const licenseOk = !license || license.live_allowed;
  const navigate = useNavigate();
  const {
    active,
    lines,
    answerHistory,
    currentQuestion,
    streamText,
    streaming,
    suggestLoading,
    error,
    reconnecting,
    sttDebug,
    sessionId,
    sessionStartedAt,
    updateAnswerEntry,
    setLiveAnswerText,
    downloadDebug,
    askQuestion,
    start,
    stop,
  } = useLiveCopilot();

  const { revise, revising } = useAnswerRevision();
  const [revisionStream, setRevisionStream] = useState('');
  const [debugOpen, setDebugOpen] = useState(false);
  const [tab, setTab] = useState<AnswerTab>('spoken');
  const [focusMode, setFocusMode] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
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

  const handleEditEntry = useCallback(
    (entryId: string, text: string) => {
      if (answerHistory.some((item) => item.id === entryId)) {
        updateAnswerEntry(entryId, text);
        return;
      }
      setManualHistory((prev) =>
        prev.map((item) => (item.id === entryId ? { ...item, spoken: text } : item)),
      );
    },
    [answerHistory, setManualHistory, updateAnswerEntry],
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

  // Warm the STT model as soon as the live screen opens, so the first question
  // isn't lost to cold-start (model load + CUDA kernel compile). We surface a
  // readiness state (not a countdown — warmup time isn't predictable) so the
  // user knows when the first question will be answered instantly.
  const [sttWarm, setSttWarm] = useState<'warming' | 'ready'>('warming');
  useEffect(() => {
    if (!hasStt) return;
    setSttWarm('warming');
    let cancelled = false;
    api
      .sttWarmup()
      .then(() => !cancelled && setSttWarm('ready'))
      .catch(() => !cancelled && setSttWarm('ready')); // don't block the user on a warmup error
    return () => {
      cancelled = true;
    };
  }, [hasStt]);

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
    // В live-сессии ручной вопрос идёт через live-конвейер (сохраняется в сессию,
    // учитывает контекст follow-up), а не через отдельный manual-канал.
    if (active) {
      askQuestion(question);
      setQuestion('');
      return;
    }
    ask();
  };

  // Pre-flight: перед стартом быстро проверяем бэкенд, LLM-ключ и микрофон,
  // чтобы о проблеме стало известно ДО первого вопроса интервьюера.
  const [preflight, setPreflight] = useState<'idle' | 'running'>('idle');
  const [preflightProblems, setPreflightProblems] = useState<string[]>([]);

  const handleStart = async () => {
    if (preflight === 'running') return;
    setPreflight('running');
    setPreflightProblems([]);
    const problems: string[] = [];

    const micCheck: Promise<void> = sources.mic
      ? navigator.mediaDevices
          .getUserMedia({ audio: true })
          .then((stream) => stream.getTracks().forEach((track) => track.stop()))
      : Promise.resolve();

    const [health, provider, mic] = await Promise.allSettled([
      api.health(),
      api.testProvider(),
      micCheck,
    ]);
    if (health.status === 'rejected') {
      problems.push(t('interview.preflight.backend'));
    }
    if (provider.status === 'rejected' || (provider.status === 'fulfilled' && !provider.value.ok)) {
      problems.push(t('interview.preflight.llm'));
    }
    if (mic.status === 'rejected') {
      problems.push(t('interview.preflight.mic'));
    }

    setPreflight('idle');
    if (problems.length > 0) {
      setPreflightProblems(problems);
      return;
    }
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
  const { tone, label: statusLabel, flowStep } = deriveLiveState({
    active,
    isGenerating,
    streaming,
    hasAnswer,
  });
  const focusAnswer = displayStream || history[history.length - 1]?.spoken || '';

  // Persist the last completed pipeline timings so Diagnostics can show a real
  // latency waterfall (that route has no live session of its own).
  useEffect(() => {
    if (dbg?.totalEndToEndMs == null) return;
    try {
      localStorage.setItem(
        'skillcue:lastTimings',
        JSON.stringify({
          firstPartialMs: dbg.timeToFirstPartialMs ?? null,
          transcribeMs: dbg.finalTranscriptionMs ?? dbg.timeToFinalMs ?? null,
          sttFinalMs: dbg.timeToFinalMs ?? null,
          llmFirstMs: dbg.llmFirstTokenMs ?? dbg.timeToAnswerMs ?? null,
          llmTotalMs: dbg.llmTotalMs ?? null,
          totalMs: dbg.totalEndToEndMs,
          at: Date.now(),
        }),
      );
    } catch {
      /* storage unavailable */
    }
    // Also record into the backend latency telemetry (p50/p95 trend + budgets).
    void api
      .recordLatency({
        stt_ms: dbg.timeToFinalMs != null ? Math.round(dbg.timeToFinalMs) : null,
        llm_first_ms: dbg.llmFirstTokenMs != null ? Math.round(dbg.llmFirstTokenMs) : null,
        llm_total_ms: dbg.llmTotalMs != null ? Math.round(dbg.llmTotalMs) : null,
        total_ms: Math.round(dbg.totalEndToEndMs),
      })
      .catch(() => {
        /* telemetry is best-effort */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbg?.totalEndToEndMs]);

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
        canStart={hasAnyKey && licenseOk}
        hasStt={hasStt}
        noSource={noSource}
        startBlocked={
          !hasAnyKey
            ? { label: t('interview.addKey'), onFix: () => navigate('/settings?tab=ai') }
            : !hasStt
              ? { label: t('interview.downloadSpeech'), onFix: () => navigate('/settings?tab=speech') }
              : null
        }
        onToggleSource={toggleSource}
        onModeChange={setMode}
        onLanguageChange={setLanguage}
        onAudioRateChange={setAudioRate}
        onStart={handleStart}
        onStop={() => void stop()}
        utilities={
          <>
            <button
              type="button"
              onClick={() => setShowTranscript((v) => !v)}
              className={`btn-secondary btn-sm ${
                showTranscript ? 'border-accent/50 text-accent' : ''
              }`}
            >
              {showTranscript ? t('interview.hideTranscript') : `${t('interview.transcript')} (${lines.length})`}
            </button>
            <FastAnswerToggle />
            <SpeculativeToggle />
            <InterviewExportButtons exportData={exportData} onDownloadDebug={downloadDebug} />
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

      <ReadinessStrip
        active={active}
        hasAnyKey={hasAnyKey}
        hasStt={hasStt}
        sttWarm={sttWarm}
        sources={sources}
      />

      {(!hasAnyKey || !hasStt) && !active && (
        <InterviewInlineAlert tone={hasAnyKey ? 'info' : 'warn'}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>
              {!hasAnyKey && !hasStt
                ? t('interview.alert.missingBoth')
                : !hasAnyKey
                  ? t('interview.alert.missingKey')
                  : t('interview.alert.missingStt')}
            </span>
            {!hasAnyKey && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => navigate('/settings?tab=ai')}
              >
                {t('interview.alert.addKey')}
              </button>
            )}
            {!hasStt && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => navigate('/settings?tab=speech')}
              >
                {t('interview.alert.downloadModel')}
              </button>
            )}
          </div>
        </InterviewInlineAlert>
      )}

      {hasStt && sttWarm === 'warming' && !active && (
        <InterviewInlineAlert tone="info">{t('interview.alert.warming')}</InterviewInlineAlert>
      )}

      {isElectron && sources.mic && !sources.system && (
        <InterviewInlineAlert tone="warn">{t('interview.alert.sysAudio')}</InterviewInlineAlert>
      )}

      {!licenseOk && (
        <InterviewInlineAlert tone="warn">
          {license?.plan === 'basic'
            ? t('interview.alert.licenseBasic')
            : t('interview.alert.licenseTrial')}
        </InterviewInlineAlert>
      )}

      {error && <InterviewInlineAlert tone="error">{error}</InterviewInlineAlert>}

      {reconnecting && <InterviewInlineAlert tone="warn">{reconnecting}</InterviewInlineAlert>}

      {preflight === 'running' && (
        <InterviewInlineAlert tone="info">{t('interview.preflight.running')}</InterviewInlineAlert>
      )}

      {preflightProblems.length > 0 && (
        <InterviewInlineAlert tone="error">
          {preflightProblems.join(' ')}
        </InterviewInlineAlert>
      )}

      <div
        className={`grid min-h-0 flex-1 grid-cols-1 gap-4 ${
          showTranscript ? 'lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]' : ''
        }`}
      >
        {showTranscript && (
          <InterviewTranscriptPanel
            lines={lines}
            debug={dbg}
            debugOpen={debugOpen}
            onDebugToggle={() => setDebugOpen((v) => !v)}
            active={active}
          />
        )}

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
            onEditEntry={handleEditEntry}
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
