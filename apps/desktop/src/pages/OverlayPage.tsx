import { useEffect, useRef, useState, type ReactNode } from 'react';
import AnswerActions from '../components/interview/AnswerActions';
import { useLiveCopilot } from '../hooks/useLiveCopilot';
import { useLiveCopilotPrefs } from '../hooks/useLiveCopilotPrefs';
import { useAnswerRevision } from '../hooks/useAnswerRevision';
import { useApp } from '../context/AppContext';
import MarkdownText from '../components/MarkdownText';
import { pipelineToStreamOpts, type AnswerRevisionMode } from '../lib/answerRevision';
import { debugInfoToPipeline } from '../lib/interviewStreamHelpers';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

const SHORTCUTS: { label: string; keys: string[] }[] = [
  { label: 'Показать / скрыть транскрипт', keys: ['Ctrl', '/'] },
  { label: 'Показать / скрыть overlay', keys: ['Ctrl', 'Shift', 'H'] },
  { label: 'Быстрые действия', keys: ['Ctrl', 'K'] },
  { label: 'Закрыть overlay', keys: ['Esc'] },
];

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="overlay-icon-btn tip"
      data-tip={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

export default function OverlayPage() {
  const { hasStt } = useApp();
  const {
    active,
    lines,
    answerHistory,
    streamText,
    streaming,
    suggestLoading,
    error,
    sttDebug,
    updateAnswerEntry,
    setLiveAnswerText,
    start,
    stop,
  } = useLiveCopilot();

  const [showTranscript, setShowTranscript] = useState(false);
  const { sources, sttOptions, setSources } = useLiveCopilotPrefs();
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shareMenuRef = useRef<HTMLDivElement>(null);
  const { revise, revising } = useAnswerRevision();
  const [revisionStream, setRevisionStream] = useState('');

  const lastEntry = answerHistory[answerHistory.length - 1];
  const lastAnswer = lastEntry?.spoken ?? '';
  const displayAnswer = revisionStream || streamText || lastAnswer;
  const displayQuestion = streamText ? '' : lastEntry?.question ?? '';

  const startWith = (next: typeof sources) => {
    setSources(next);
    setShareMenuOpen(false);
    void start(next, sttOptions);
  };

  const toggleSession = () => {
    if (active) void stop();
    else void start(sources, sttOptions);
  };

  const handleExit = () => {
    void stop();
    void window.electronAPI?.overlay.hide();
  };

  const handleRevise = (mode: AnswerRevisionMode) => {
    const question = displayQuestion || lastEntry?.question;
    if (!question || !displayAnswer.trim()) return;

    setRevisionStream('');
    revise(
      question,
      displayAnswer,
      mode,
      pipelineToStreamOpts(question, lastEntry?.pipeline ?? debugInfoToPipeline(sttDebug)),
      {
        onStream: setRevisionStream,
        onDone: (text) => {
          if (lastEntry) updateAnswerEntry(lastEntry.id, text);
          else setLiveAnswerText(text);
          setRevisionStream('');
        },
        onError: () => setRevisionStream(''),
      },
    );
  };

  useEffect(() => {
    if (!shareMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (shareMenuRef.current && !shareMenuRef.current.contains(e.target as Node)) {
        setShareMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [shareMenuOpen]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (shortcutsOpen) setShortcutsOpen(false);
        else if (shareMenuOpen) setShareMenuOpen(false);
        else void window.electronAPI?.overlay.hide();
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        setShowTranscript((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcutsOpen, shareMenuOpen]);

  return (
    <div className="overlay-shell">
      <div className="overlay-topbar">
        <IconButton
          title={showTranscript ? 'Скрыть транскрипт (Ctrl+/)' : 'Показать транскрипт (Ctrl+/)'}
          onClick={() => setShowTranscript((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {showTranscript ? (
              <path d="M15 18l-6-6 6-6" />
            ) : (
              <path d="M9 18l6-6-6-6" />
            )}
          </svg>
        </IconButton>

        <div className="overlay-brand">SC</div>
        <span className="overlay-title">SkillCue</span>

        <div className="overlay-drag flex-1 self-stretch" />

        <div className="overlay-no-drag flex items-center gap-2 shrink-0">
          <div className="relative flex items-center" ref={shareMenuRef}>
            <button
              type="button"
              onClick={toggleSession}
              disabled={!hasStt && !active}
              data-tip={
                !hasStt
                  ? 'Скачайте локальную модель в Настройках → Распознавание речи'
                  : active
                    ? 'Остановить live-сессию'
                    : 'Начать live-сессию (захват аудио)'
              }
              className={`tip btn-sm rounded-l-xl border-y border-l px-3 py-1.5 text-xs font-medium ${
                active ? 'btn-danger rounded-r-none' : 'btn-secondary rounded-r-none'
              }`}
            >
              <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${active ? 'animate-pulse bg-red-400' : 'bg-red-500'}`} />
              {active ? 'Stop' : 'Share Audio'}
            </button>
            <button
              type="button"
              onClick={() => setShareMenuOpen((v) => !v)}
              className={`tip btn-sm rounded-r-xl border px-1.5 py-1.5 text-xs ${
                active ? 'btn-danger border-l-0' : 'btn-secondary border-l-0'
              }`}
              data-tip="Выбрать источник звука"
            >
              ▾
            </button>

            {shareMenuOpen && (
              <div className="overlay-menu">
                <p className="px-2 py-1.5 text-[11px] text-ink-faint">
                  Источник для live-транскрипции и ответов.
                </p>
                <button type="button" onClick={() => startWith({ mic: true, system: true })} className="btn-ghost w-full justify-start rounded-lg px-2 py-2 text-xs">
                  Микрофон + система
                </button>
                <button type="button" onClick={() => startWith({ mic: true, system: false })} className="btn-ghost w-full justify-start rounded-lg px-2 py-2 text-xs">
                  Только микрофон
                </button>
                {isElectron && (
                  <button type="button" onClick={() => startWith({ mic: false, system: true })} className="btn-ghost w-full justify-start rounded-lg px-2 py-2 text-xs">
                    Только звук системы
                  </button>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleExit}
            data-tip="Закрыть overlay (Esc)"
            className="tip btn-secondary btn-sm"
          >
            Exit
          </button>

          <IconButton title="Быстрые действия (Ctrl+K)" onClick={() => setShortcutsOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
            </svg>
          </IconButton>
          <IconButton title="Настройки" onClick={() => void window.electronAPI?.overlay.openSettings?.()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          </IconButton>
        </div>
      </div>

      <div className="overlay-no-drag flex min-h-0 flex-1">
        {showTranscript && (
          <div className="overlay-panel w-[38%] shrink-0">
            <div className="overlay-panel-head">Transcript</div>
            <div className="flex-1 overflow-y-auto p-4 space-y-1.5 text-sm">
              {lines.length === 0 && (
                <p className="text-ink-faint">Share audio to start transcription</p>
              )}
              {lines.map((line, i) => (
                <div key={i}>
                  <p>
                    <span className={line.speaker === 'me' ? 'text-accent' : 'text-emerald-400'}>
                      {line.speaker === 'me' ? 'You: ' : 'Interviewer: '}
                    </span>
                    <span className={line.isFinal ? 'text-ink' : 'italic text-ink-muted'}>
                      {line.text}
                    </span>
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="overlay-answer">
          {error && <p className="mb-3 text-red-400">{error}</p>}

          {!active && !displayAnswer && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-ink-faint">
              <p>Click Share Audio to start SkillCue.</p>
              <p className="text-xs">Ctrl+K — keyboard shortcuts</p>
            </div>
          )}

          {(suggestLoading || revising) && !displayAnswer && (
            <p className="animate-pulse text-ink-muted">Generating answer…</p>
          )}

          {displayAnswer ? (
            <div className="cockpit-bento space-y-3">
              {displayQuestion ? <p className="answer-question">Q: {displayQuestion}</p> : null}
              <div className="flex justify-end">
                <AnswerActions
                  answer={displayAnswer}
                  disabled={streaming || suggestLoading}
                  revising={revising}
                  onRevise={handleRevise}
                />
              </div>
              <MarkdownText text={displayAnswer} />
            </div>
          ) : null}
        </div>
      </div>

      {shortcutsOpen && (
        <div
          className="overlay-no-drag absolute inset-0 z-50 flex items-start justify-center bg-black/50 pt-20"
          onClick={() => setShortcutsOpen(false)}
        >
          <div className="overlay-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">Keyboard shortcuts</h3>
              <button type="button" onClick={() => setShortcutsOpen(false)} className="overlay-icon-btn">
                ✕
              </button>
            </div>
            <div className="space-y-0.5">
              {SHORTCUTS.map((s) => (
                <div key={s.label} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-surface-hover">
                  <span className="text-sm text-ink-muted">{s.label}</span>
                  <span className="flex items-center gap-1">
                    {s.keys.map((k) => (
                      <kbd key={k} className="cockpit-kbd">
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
