import { useState } from 'react';
import { useLiveCopilot, LiveSources } from '../hooks/useLiveCopilot';
import { useApp } from '../context/AppContext';
import MarkdownText from './MarkdownText';

interface Props {
  compact?: boolean;
  canStart?: boolean;
}

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

export default function LiveCopilot({ compact = false, canStart = true }: Props) {
  const { hasStt } = useApp();
  const { active, lines, answerHistory, streamText, streaming, suggestLoading, error, start, stop } =
    useLiveCopilot();
  const lastAnswer = answerHistory[answerHistory.length - 1]?.spoken ?? '';
  const [sources, setSources] = useState<LiveSources>(() => ({
    mic: true,
    system: isElectron,
  }));

  const toggle = (key: keyof LiveSources) => setSources((s) => ({ ...s, [key]: !s[key] }));
  const noSource = !sources.mic && !sources.system;

  return (
    <div className={compact ? 'flex h-full flex-col gap-2' : 'card p-4'}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${active ? 'animate-pulse bg-red-500' : 'bg-ink-faint'}`} />
          <span className="text-sm text-ink-muted">
            {active ? 'Идёт прослушивание' : 'Live-режим выключен'}
          </span>
        </div>
        {active ? (
          <button onClick={() => void stop()} className="btn-danger btn-sm">
            Стоп
          </button>
        ) : (
          <button
            onClick={() => void start(sources)}
            disabled={!canStart || !hasStt || noSource}
            title={!hasStt ? 'Добавьте Deepgram API key в Настройках' : ''}
            className="btn-primary btn-sm"
          >
            Старт live
          </button>
        )}
      </div>

      {!active && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={sources.mic} onChange={() => toggle('mic')} />
            <span className="text-ink-muted">Микрофон (вы)</span>
          </label>
          <label
            className={`flex items-center gap-1.5 ${isElectron ? '' : 'opacity-40'}`}
            title={isElectron ? '' : 'Доступно только в десктоп-приложении'}
          >
            <input type="checkbox" checked={sources.system} disabled={!isElectron} onChange={() => toggle('system')} />
            <span className="text-ink-muted">Звук собеседника (система)</span>
          </label>
        </div>
      )}

      {error && <p className="mt-1 text-sm text-red-400">{error}</p>}

      <div className={`grid gap-3 ${compact ? 'min-h-0 flex-1 grid-cols-2' : 'mt-3 grid-cols-2'}`}>
        <div className="overflow-y-auto rounded-xl border border-surface-border bg-surface p-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Транскрипт
          </p>
          {lines.length === 0 && <p className="text-sm text-ink-faint">—</p>}
          {lines.map((l, i) => (
            <div key={i} className="text-sm leading-relaxed">
              <p>
                <span className={l.speaker === 'me' ? 'text-accent' : 'text-emerald-400'}>
                  {l.speaker === 'me' ? 'Вы: ' : 'Собеседник: '}
                </span>
                <span className={l.isFinal ? 'text-ink' : 'italic text-ink-faint'}>{l.text}</span>
              </p>
              {l.normalized && l.normalized !== l.text && (
                <p className="pl-1 text-xs text-ink-faint">→ {l.normalized}</p>
              )}
            </div>
          ))}
        </div>
        <div className="overflow-y-auto rounded-xl border border-surface-border bg-surface p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Подсказка {suggestLoading && !streamText && '· генерация...'}
            {streaming && streamText && '· печатает...'}
          </p>
          {streamText ? (
            <MarkdownText text={streamText} />
          ) : lastAnswer ? (
            <MarkdownText text={lastAnswer} />
          ) : (
            <p className="text-sm text-ink-faint">Ответы появятся после реплики собеседника</p>
          )}
        </div>
      </div>
    </div>
  );
}
