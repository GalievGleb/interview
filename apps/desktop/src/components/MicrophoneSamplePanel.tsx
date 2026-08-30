import { CircleStop, Mic2, Pause, Play, RotateCcw } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import {
  formatMicrophoneSampleDuration,
  type MicrophoneSampleState,
} from '../lib/microphoneSample';

interface MicrophoneSamplePanelProps {
  state: MicrophoneSampleState;
  onStart: () => void;
  onStop: () => void;
  onPlayPause: () => void;
  onReset: () => void;
}

export default function MicrophoneSamplePanel({
  state,
  onStart,
  onStop,
  onPlayPause,
  onReset,
}: MicrophoneSamplePanelProps) {
  const { t } = useI18n();
  const recording = state.status === 'recording';
  const hasSample = state.status === 'ready' || state.status === 'playing';
  const statusText = recording
    ? `${t('mic.sample.recording')} · ${formatMicrophoneSampleDuration(state.elapsedMs)}`
    : hasSample
      ? `${t('mic.sample.ready')} · ${formatMicrophoneSampleDuration(state.durationMs)}`
      : t('mic.sample.idle');

  return (
    <div className="rounded-2xl border border-surface-border bg-surface-light/65 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border ${
            recording
              ? 'border-red-400/30 bg-red-400/10 text-red-400'
              : 'border-accent/25 bg-accent/10 text-accent'
          }`}
        >
          <Mic2 size={18} strokeWidth={2} aria-hidden="true" />
        </span>

        <div className="min-w-[180px] flex-1">
          <p className="text-[13px] font-semibold text-ink">{t('mic.sample.title')}</p>
          <p className="mt-0.5 text-xs text-ink-faint" aria-live="polite">
            {statusText}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {state.status === 'idle' && (
            <button type="button" className="btn-primary btn-sm" onClick={onStart}>
              <Mic2 size={14} aria-hidden="true" />
              {t('mic.sample.start')}
            </button>
          )}
          {recording && (
            <button type="button" className="btn-danger btn-sm" onClick={onStop}>
              <CircleStop size={14} aria-hidden="true" />
              {t('mic.sample.stop')}
            </button>
          )}
          {hasSample && (
            <>
              <button type="button" className="btn-primary btn-sm" onClick={onPlayPause}>
                {state.status === 'playing' ? (
                  <Pause size={14} aria-hidden="true" />
                ) : (
                  <Play size={14} aria-hidden="true" />
                )}
                {state.status === 'playing' ? t('mic.sample.pause') : t('mic.sample.play')}
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={onReset}>
                <RotateCcw size={14} aria-hidden="true" />
                {t('mic.sample.retry')}
              </button>
            </>
          )}
        </div>
      </div>

      {recording && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-faint">
            <span>{t('mic.sample.level')}</span>
            <span className="tabular-nums">{Math.round(state.level)}%</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-surface"
            role="progressbar"
            aria-label={t('mic.sample.level')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.level)}
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-75 motion-reduce:transition-none"
              style={{ width: `${Math.max(2, state.level)}%` }}
            />
          </div>
        </div>
      )}

      {state.error && (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {state.error}
        </p>
      )}
    </div>
  );
}
