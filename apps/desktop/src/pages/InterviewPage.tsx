import { useEffect, useRef, useState } from 'react';
import { api, InterviewAnswer } from '../lib/api';
import { getSuggestionText } from '../lib/suggestionText';
import MarkdownText from '../components/MarkdownText';
import SttDebugPanel from '../components/SttDebugPanel';
import { prepareTranscriptForLlm } from '../lib/prepareTranscriptForLlm';
import { useApp } from '../context/AppContext';
import { useLiveCopilot, LiveSources } from '../hooks/useLiveCopilot';
import { SttMode } from '../lib/liveSession';
import {
  AUDIO_RATE_LABELS,
  AudioSampleRateMode,
  STT_ENGINE_LABELS,
  SttEngine,
} from '../lib/sttOptions';

type Tab = 'short' | 'spoken' | 'detailed' | 'english' | 'risk';

const TABS: { key: Tab; label: string }[] = [
  { key: 'short', label: 'Кратко' },
  { key: 'spoken', label: 'Сказать вслух' },
  { key: 'detailed', label: 'Подробно' },
  { key: 'english', label: 'English' },
  { key: 'risk', label: 'Риски' },
];

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

export default function InterviewPage() {
  const { hasAnyKey, hasStt } = useApp();
  const { active, lines, suggestion, streamText, streaming, suggestLoading, error, sttDebug, start, stop } =
    useLiveCopilot();

  const [debugOpen, setDebugOpen] = useState(false);

  const [sources, setSources] = useState<LiveSources>({ mic: true, system: false });
  const [mode, setMode] = useState<SttMode>('stable');
  const [language, setLanguage] = useState('ru');
  const [sttEngine, setSttEngine] = useState<SttEngine>('nova3-multi');
  const [audioRate, setAudioRate] = useState<AudioSampleRateMode>('16k');
  const [question, setQuestion] = useState('');
  const [manualAnswer, setManualAnswer] = useState<InterviewAnswer | null>(null);
  const [manualStream, setManualStream] = useState('');
  const [tab, setTab] = useState<Tab>('spoken');
  const [loading, setLoading] = useState(false);
  const [manualError, setManualError] = useState('');
  const cancelManualRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (suggestion) setTab('spoken');
  }, [suggestion]);

  const displayStream = streamText || manualStream;
  const current = suggestion ?? manualAnswer;
  const noSource = !sources.mic && !sources.system;
  const toggle = (key: keyof LiveSources) => setSources((s) => ({ ...s, [key]: !s[key] }));

  const ask = () => {
    if (!question.trim()) return;
    cancelManualRef.current?.();
    setLoading(true);
    setManualError('');
    setManualAnswer(null);
    setManualStream('');
    setTab('spoken');

    let text = '';
    const prepared = prepareTranscriptForLlm(question);
    cancelManualRef.current = api.streamInterview(
      prepared.intentCorrected,
      {
        onChunk: (chunk) => {
          text += chunk;
          setManualStream(text);
          setLoading(false);
        },
        onDone: (spoken) => {
          setManualStream(spoken);
          setManualAnswer({
            id: '',
            short: spoken.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '),
            spoken,
            detailed: '',
            english: '',
            risk: '',
          });
          setLoading(false);
        },
        onError: (msg) => {
          setManualError(msg);
          setLoading(false);
        },
      },
      {
        rawQuestion: prepared.rawTranscript,
        glossaryCorrected: prepared.corrected,
        intentCorrected: prepared.intentCorrected,
        ambiguity: prepared.intent.ambiguity,
        corrections: prepared.correction.corrections,
        intentCorrections: prepared.intent.intentCorrections,
        intentConfidence:
          prepared.intent.confidence !== 'none' ? prepared.intent.confidence : undefined,
        intentReason: prepared.intent.reason,
        needsLlmCorrection: prepared.correction.needsLlmCorrection,
      },
    );
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h2 className="page-title">Interview Copilot</h2>
          <p className="page-subtitle">
            Ответы строятся на вашем резюме и вакансии
          </p>
        </div>
        {isElectron && (
          <button onClick={() => void window.electronAPI?.overlay.toggle()} className="btn-ghost btn-sm">
            Overlay · Ctrl+Shift+H
          </button>
        )}
      </div>

      {!hasAnyKey && (
        <div className="mb-4 rounded-xl border border-amber-700/30 bg-amber-950/20 p-3.5 text-sm text-amber-200">
          Сначала добавьте API-ключ в «Настройках».
        </div>
      )}

      {/* Control bar */}
      <div className="card mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${active ? 'animate-pulse bg-red-500' : 'bg-ink-faint'}`} />
            <span className="text-sm text-ink-muted">{active ? 'Идёт прослушивание' : 'Live выключен'}</span>
          </div>
          {!active && (
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={sources.mic} onChange={() => toggle('mic')} />
                <span className="text-ink-muted">Микрофон</span>
              </label>
              <label
                className={`flex items-center gap-1.5 ${isElectron ? '' : 'opacity-40'}`}
                title={isElectron ? '' : 'Только в десктоп-приложении'}
              >
                <input
                  type="checkbox"
                  checked={sources.system}
                  disabled={!isElectron}
                  onChange={() => toggle('system')}
                />
                <span className="text-ink-muted">Звук собеседника</span>
              </label>

              <div className="ml-1 flex items-center gap-1 rounded-lg border border-surface-border p-0.5">
                {(['fast', 'stable'] as SttMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    title={m === 'fast' ? 'Быстрее, но хуже распознаёт термины' : 'Точнее STT (+~0.3 с, рекомендуется)'}
                    className={`rounded-md px-2 py-0.5 transition-colors ${
                      mode === m ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {m === 'fast' ? 'Быстрый' : 'Стабильный'}
                  </button>
                ))}
              </div>

              <select
                value={sttEngine}
                onChange={(e) => setSttEngine(e.target.value as SttEngine)}
                title="A/B: меняйте только STT или только audio rate за раз"
                className="max-w-[140px] rounded-lg border border-surface-border bg-surface px-2 py-1 text-xs text-ink-muted outline-none focus:border-accent"
              >
                {(Object.keys(STT_ENGINE_LABELS) as SttEngine[]).map((id) => (
                  <option key={id} value={id}>
                    {STT_ENGINE_LABELS[id]}
                  </option>
                ))}
              </select>

              <select
                value={audioRate}
                onChange={(e) => setAudioRate(e.target.value as AudioSampleRateMode)}
                title="16k resampled vs native sample rate без даунсемпла до 16k"
                className="max-w-[150px] rounded-lg border border-surface-border bg-surface px-2 py-1 text-xs text-ink-muted outline-none focus:border-accent"
              >
                {(Object.keys(AUDIO_RATE_LABELS) as AudioSampleRateMode[]).map((id) => (
                  <option key={id} value={id}>
                    {AUDIO_RATE_LABELS[id]}
                  </option>
                ))}
              </select>

              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                title="Язык распознавания речи"
                className="rounded-lg border border-surface-border bg-surface px-2 py-1 text-xs text-ink-muted outline-none focus:border-accent"
              >
                <option value="ru">Русский</option>
                <option value="multi">Авто (ru+en)</option>
                <option value="en">English</option>
              </select>
            </div>
          )}
        </div>
        {active ? (
          <button onClick={() => void stop()} className="btn-danger btn-sm">
            Остановить
          </button>
        ) : (
          <button
            onClick={() =>
              void start(sources, {
                mode,
                language,
                engine: sttEngine,
                audioSampleRate: audioRate,
              })
            }
            disabled={!hasAnyKey || !hasStt || noSource}
            title={!hasStt ? 'Добавьте Deepgram API key в Настройках' : ''}
            className="btn-primary btn-sm"
          >
            Старт live
          </button>
        )}
      </div>

      {!hasStt && (
        <div className="mb-3 rounded-xl border border-surface-border bg-surface-light p-3 text-sm text-ink-muted">
          Live-транскрипция работает через Deepgram. Добавьте{' '}
          <span className="text-ink">Deepgram API key</span> в «Настройках» (есть бесплатный
          стартовый лимит). Ручной ввод вопроса ниже работает и без него.
        </div>
      )}

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {/* Two-column session */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Transcription */}
        <div className="card flex min-h-0 flex-col">
          <div className="border-b border-surface-border px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">Транскрипция</h3>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4">
            {lines.length === 0 && (
              <p className="text-sm text-ink-faint">
                Нажмите «Старт live» — реплики появятся здесь.
              </p>
            )}
            {lines.map((l, i) => (
              <div key={i} className="text-sm leading-relaxed">
                <p>
                  <span className={l.speaker === 'me' ? 'font-medium text-accent' : 'font-medium text-emerald-400'}>
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
          <SttDebugPanel debug={sttDebug} show={debugOpen} onToggle={() => setDebugOpen((v) => !v)} />
        </div>

        {/* Copilot */}
        <div className="card flex min-h-0 flex-col">
          <div className="flex items-center gap-1 border-b border-surface-border px-2 py-2">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  tab === t.key ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover'
                }`}
              >
                {t.label}
              </button>
            ))}
            {suggestLoading && !displayStream && (
              <span className="ml-auto pr-2 text-xs text-ink-faint">генерация...</span>
            )}
            {streaming && displayStream && (
              <span className="ml-auto pr-2 text-xs text-ink-faint">печатает...</span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {displayStream && (tab === 'spoken' || tab === 'short') ? (
              <MarkdownText text={displayStream} />
            ) : current ? (
              tab === 'spoken' || tab === 'short' ? (
                <MarkdownText text={getSuggestionText(current, tab === 'short' ? 'short' : 'spoken')} />
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{current[tab] || '—'}</p>
              )
            ) : (
              <p className="text-sm text-ink-faint">
                Подсказки появятся во время live или после ручного вопроса ниже.
              </p>
            )}
          </div>

          <div className="border-t border-surface-border p-3">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void ask();
              }}
              placeholder="Введите вопрос вручную (Ctrl+Enter)"
              rows={2}
              className="field resize-none"
            />
            <div className="mt-2 flex items-center gap-3">
              <button onClick={ask} disabled={loading || !hasAnyKey} className="btn-primary btn-sm">
                {loading ? 'Генерация...' : 'Получить ответ'}
              </button>
              {manualError && <p className="text-sm text-red-400">{manualError}</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
