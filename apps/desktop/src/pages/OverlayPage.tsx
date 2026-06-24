import { useState } from 'react';
import { useLiveCopilot, LiveSources } from '../hooks/useLiveCopilot';
import { useApp } from '../context/AppContext';
import MarkdownText from '../components/MarkdownText';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

type Tab = 'copilot' | 'chatbot' | 'cheatsheet';

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
    start,
    stop,
  } = useLiveCopilot();

  const [tab, setTab] = useState<Tab>('copilot');
  const [showTranscript, setShowTranscript] = useState(false);
  const [sources] = useState<LiveSources>({ mic: true, system: isElectron });

  const lastAnswer = answerHistory[answerHistory.length - 1]?.spoken ?? '';

  const handleShareAudio = () => {
    if (active) {
      void stop();
    } else {
      void start(sources);
    }
  };

  const handleExit = () => {
    void stop();
    void window.electronAPI?.overlay.hide();
  };

  return (
    <div className="overlay-drag flex h-screen flex-col bg-[#0d0d0d] text-white select-none overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center border-b border-white/10 px-3 py-0 overlay-drag" style={{ minHeight: 44 }}>

        {/* Left: back arrow + logo + title + tabs */}
        <div className="overlay-no-drag flex items-center gap-0 flex-1 min-w-0">
          <button
            onClick={() => setShowTranscript((v) => !v)}
            className="mr-2 flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
            title={showTranscript ? 'Скрыть транскрипт' : 'Показать транскрипт'}
          >
            {showTranscript ? '←' : '→'}
          </button>

          <div className="flex h-6 w-6 items-center justify-center rounded bg-white/10 text-xs font-bold mr-2 shrink-0">
            V
          </div>
          <span className="text-sm font-medium text-gray-200 mr-4 shrink-0">Candidate @ Your Company</span>

          {/* Tabs */}
          <div className="flex items-center">
            {(
              [
                { key: 'copilot', label: 'Interview Copilot', icon: '🎯' },
                { key: 'chatbot', label: 'Chatbot', icon: '💬' },
                { key: 'cheatsheet', label: 'Cheatsheet', icon: '☑️' },
              ] as { key: Tab; label: string; icon: string }[]
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1 px-3 py-3 text-xs font-medium border-b-2 transition-colors ${
                  tab === t.key
                    ? 'border-white text-white'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                <span>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right: controls */}
        <div className="overlay-no-drag flex items-center gap-2 shrink-0">
          <div className="relative">
            <button
              onClick={handleShareAudio}
              disabled={!hasStt && !active}
              title={!hasStt ? 'Добавьте Deepgram API key в Настройках' : ''}
              className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? 'border-red-500/60 bg-red-900/40 text-red-300 hover:bg-red-900/60'
                  : 'border-white/20 bg-white/5 text-white hover:bg-white/10 disabled:opacity-40'
              }`}
            >
              <span className={active ? 'animate-pulse text-red-400' : 'text-red-400'}>◉</span>
              {active ? 'Stop' : 'Share Audio'}
              {!active && <span className="ml-0.5 text-gray-400">▾</span>}
            </button>
            {!active && (
              <span className="absolute -right-1 -top-1.5 rounded bg-red-600 px-1 py-0.5 text-[9px] font-bold leading-none">
                Required
              </span>
            )}
          </div>

          <button
            onClick={handleExit}
            className="rounded border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10"
          >
            Exit
          </button>

          <div className="mx-1 h-4 w-px bg-white/20" />

          <button
            onClick={() => active ? void stop() : void start(sources)}
            className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white"
            title={active ? 'Пауза' : 'Старт'}
          >
            {active ? '⏸' : '▶'}
          </button>
          <button className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">
            💬
          </button>
          <button
            onClick={() => void window.electronAPI?.overlay.openSettings?.()}
            className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="overlay-no-drag flex min-h-0 flex-1">
        {/* Transcript panel (collapsible) */}
        {showTranscript && (
          <div className="flex w-[38%] shrink-0 flex-col border-r border-white/10">
            <div className="border-b border-white/10 px-4 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Transcription
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-1.5 text-sm">
              {lines.length === 0 && (
                <p className="text-gray-500">Start using Interview Copilot by sharing audio</p>
              )}
              {lines.map((line, i) => (
                <div key={i}>
                  <p>
                    <span className={line.speaker === 'me' ? 'text-blue-400' : 'text-emerald-400'}>
                      {line.speaker === 'me' ? 'Вы: ' : 'Собеседник: '}
                    </span>
                    <span className={line.isFinal ? 'text-white' : 'italic text-gray-400'}>
                      {line.text}
                    </span>
                  </p>
                  {line.normalized && line.normalized !== line.text && (
                    <p className="pl-1 text-xs text-gray-500">→ {line.normalized}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Right panel */}
        <div className="flex min-w-0 flex-1 flex-col">
          {tab === 'copilot' && (
            <div className="flex-1 overflow-y-auto p-5 text-sm leading-relaxed">
              {error && <p className="mb-3 text-red-400">{error}</p>}

              {!active && !streamText && !lastAnswer && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-gray-500">
                  <p>
                    Click{' '}
                    <button
                      onClick={handleShareAudio}
                      className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/5 px-2 py-0.5 text-xs text-white hover:bg-white/10"
                    >
                      <span className="text-red-400">◉</span> Share Audio
                    </button>{' '}
                    to get started.
                  </p>
                  <p className="text-xs">
                    Press{' '}
                    <kbd className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-gray-300">
                      Ctrl
                    </kbd>{' '}
                    +{' '}
                    <kbd className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-gray-300">
                      K
                    </kbd>{' '}
                    to open keyboard shortcuts.
                  </p>
                </div>
              )}

              {(suggestLoading && !streamText) && (
                <p className="animate-pulse text-gray-400">Generating suggestion...</p>
              )}

              {streamText ? (
                <MarkdownText text={streamText} />
              ) : lastAnswer ? (
                <MarkdownText text={lastAnswer} />
              ) : null}

              {streaming && streamText && (
                <span className="ml-1 inline-block h-3 w-0.5 animate-pulse bg-white/60" />
              )}
            </div>
          )}
          {tab === 'chatbot' && (
            <div className="flex flex-1 items-center justify-center text-gray-500 text-sm">
              Chatbot coming soon
            </div>
          )}
          {tab === 'cheatsheet' && (
            <div className="flex flex-1 items-center justify-center text-gray-500 text-sm">
              Cheatsheet coming soon
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
