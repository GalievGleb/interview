import type { ReactNode } from 'react';
import { LiveSources } from '../../hooks/useLiveCopilot';
import { SttMode } from '../../lib/liveSession';
import { AUDIO_RATE_LABELS, AudioSampleRateMode } from '../../lib/sttOptions';
import type { LiveTone } from '../../lib/liveStatus';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

export type { LiveTone };

const FLOW = ['Listening', 'Transcribing', 'Answering'];

function secs(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`;
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className={`sc-metric ${accent ? 'sc-metric--accent' : ''}`}>
      <span className="sc-metric__label">{label}</span>
      <span className="sc-metric__value">{value}</span>
    </span>
  );
}

export interface LiveStatusBarProps {
  active: boolean;
  statusLabel: string;
  tone: LiveTone;
  flowStep: number; // -1 none, 0 listening, 1 transcribing, 2 answering
  sttMs?: number;
  llmMs?: number;
  totalMs?: number;
  sources: LiveSources;
  mode: SttMode;
  language: string;
  audioRate: AudioSampleRateMode;
  canStart: boolean;
  hasStt: boolean;
  noSource: boolean;
  onToggleSource: (key: keyof LiveSources) => void;
  onModeChange: (mode: SttMode) => void;
  onLanguageChange: (language: string) => void;
  onAudioRateChange: (rate: AudioSampleRateMode) => void;
  onStart: () => void;
  onStop: () => void;
  utilities?: ReactNode;
}

const PILL_TONE: Record<LiveTone, string> = {
  idle: '',
  listening: 'sc-status-pill--live',
  processing: 'sc-status-pill--processing',
  ready: 'sc-status-pill--ready',
};

const DOT_TONE: Record<LiveTone, string> = {
  idle: 'bg-ink-faint',
  listening: 'bg-emerald-400',
  processing: 'bg-amber-400',
  ready: 'bg-accent',
};

export default function LiveStatusBar(props: LiveStatusBarProps) {
  const {
    active,
    statusLabel,
    tone,
    flowStep,
    sttMs,
    llmMs,
    totalMs,
    sources,
    mode,
    language,
    audioRate,
    canStart,
    hasStt,
    noSource,
    onToggleSource,
    onModeChange,
    onLanguageChange,
    onAudioRateChange,
    onStart,
    onStop,
    utilities,
  } = props;

  return (
    <div className="sticky top-0 z-10 mb-4 rounded-2xl border border-surface-border bg-surface/80 p-3 shadow-soft backdrop-blur-sm">
      {/* Row 1 — status + flow + latency + start/stop */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`sc-status-pill ${PILL_TONE[tone]}`}>
          {tone === 'idle' ? (
            <span className={`sc-dot ${DOT_TONE[tone]}`} />
          ) : (
            <span className="sc-ping">
              <span className={`sc-ping__halo ${DOT_TONE[tone]}`} />
              <span className={`sc-ping__core ${DOT_TONE[tone]}`} />
            </span>
          )}
          {statusLabel}
        </span>

        <span className="sc-flow">
          {FLOW.map((step, i) => (
            <span key={step} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="sc-flow__sep">→</span>}
              <span className={`sc-flow__step ${i === flowStep ? 'sc-flow__step--active' : ''}`}>
                {step}
              </span>
            </span>
          ))}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Metric label="STT" value={secs(sttMs)} />
          <Metric label="LLM" value={secs(llmMs)} />
          <Metric label="Total" value={secs(totalMs)} accent />
          {active ? (
            <button type="button" onClick={onStop} className="btn-danger btn-sm">
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onStart}
              disabled={!canStart || !hasStt || noSource}
              title={!hasStt ? 'Download a local speech model in Settings → Speech Recognition' : undefined}
              className="btn-primary btn-sm min-w-[110px]"
            >
              Start Live
            </button>
          )}
        </div>
      </div>

      {/* Row 2 — controls + utilities */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-surface-border/80 pt-3">
        <div className="sc-segmented" role="group" aria-label="Audio sources">
          <button
            type="button"
            onClick={() => onToggleSource('mic')}
            className={`sc-segmented__item ${sources.mic ? 'sc-segmented__item--active' : ''}`}
          >
            Mic
          </button>
          <button
            type="button"
            onClick={() => onToggleSource('system')}
            disabled={!isElectron}
            title={isElectron ? undefined : 'Desktop app only'}
            className={`sc-segmented__item ${sources.system ? 'sc-segmented__item--active' : ''} ${
              isElectron ? '' : 'opacity-40'
            }`}
          >
            System audio
          </button>
        </div>

        {active ? (
          <div className="sc-statbar text-xs">
            <span className="sc-statchip">
              <span className="sc-statchip__label">STT</span>
              <span className="sc-statchip__value">Local Whisper</span>
            </span>
            <span className="sc-statchip">
              <span className="sc-statchip__label">Mode</span>
              <span className="sc-statchip__value">{mode === 'fast' ? 'Fast' : 'Stable'}</span>
            </span>
            <span className="sc-statchip">
              <span className="sc-statchip__label">Lang</span>
              <span className="sc-statchip__value uppercase">{language}</span>
            </span>
          </div>
        ) : (
          <>
            <div className="sc-segmented" role="group" aria-label="STT mode">
              {(['fast', 'stable'] as SttMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onModeChange(m)}
                  title={m === 'fast' ? 'Faster, weaker on technical terms' : 'More accurate (+~0.3s)'}
                  className={`sc-segmented__item ${mode === m ? 'sc-segmented__item--active' : ''}`}
                >
                  {m === 'fast' ? 'Fast' : 'Stable'}
                </button>
              ))}
            </div>
            <select
              value={audioRate}
              onChange={(e) => onAudioRateChange(e.target.value as AudioSampleRateMode)}
              className="select-compact min-w-[140px]"
            >
              {(Object.keys(AUDIO_RATE_LABELS) as AudioSampleRateMode[]).map((id) => (
                <option key={id} value={id}>
                  {AUDIO_RATE_LABELS[id]}
                </option>
              ))}
            </select>
            <select
              value={language}
              onChange={(e) => onLanguageChange(e.target.value)}
              className="select-compact min-w-[120px]"
            >
              <option value="ru">Russian</option>
              <option value="multi">Auto (ru+en)</option>
              <option value="en">English</option>
            </select>
          </>
        )}

        {utilities && <div className="ml-auto flex items-center gap-2">{utilities}</div>}
      </div>
    </div>
  );
}
