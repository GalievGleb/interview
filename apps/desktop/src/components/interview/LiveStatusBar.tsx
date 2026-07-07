import type { ReactNode } from 'react';
import { LiveSources } from '../../hooks/useLiveCopilot';
import { SttMode } from '../../lib/liveSession';
import { AUDIO_RATE_LABELS, AudioSampleRateMode } from '../../lib/sttOptions';
import { useI18n, type I18nKey } from '../../lib/i18n';
import type { LiveTone } from '../../lib/liveStatus';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

export type { LiveTone };

const FLOW_KEYS: I18nKey[] = ['live.listening', 'live.transcribing', 'live.answering'];

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
  /** When setup is incomplete, the primary action becomes fixing it. */
  startBlocked?: { label: string; onFix: () => void } | null;
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
  const { t } = useI18n();
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
    startBlocked,
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
          {FLOW_KEYS.map((stepKey, i) => (
            <span key={stepKey} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="sc-flow__sep">→</span>}
              <span className={`sc-flow__step ${i === flowStep ? 'sc-flow__step--active' : ''}`}>
                {t(stepKey)}
              </span>
            </span>
          ))}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {active ? (
            <button type="button" onClick={onStop} className="btn-danger btn-sm">
              {t('live.stop')}
            </button>
          ) : startBlocked ? (
            <button
              type="button"
              onClick={startBlocked.onFix}
              className="btn-primary btn-sm min-w-[110px]"
            >
              {startBlocked.label}
            </button>
          ) : (
            <button
              type="button"
              onClick={onStart}
              disabled={!canStart || !hasStt || noSource}
              title={noSource ? t('live.chooseSourceBelow') : undefined}
              className="btn-primary btn-sm min-w-[110px]"
            >
              {t('live.start')}
            </button>
          )}
        </div>
      </div>

      {/* Row 2 — controls + utilities */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-surface-border/80 pt-3">
        <div className="sc-segmented" role="group" aria-label={t('live.sourcesAria')}>
          <button
            type="button"
            onClick={() => onToggleSource('mic')}
            className={`sc-segmented__item ${sources.mic ? 'sc-segmented__item--active' : ''}`}
          >
            {t('live.microphone')}
          </button>
          <button
            type="button"
            onClick={() => onToggleSource('system')}
            disabled={!isElectron}
            title={isElectron ? undefined : t('live.desktopOnly')}
            className={`sc-segmented__item ${sources.system ? 'sc-segmented__item--active' : ''} ${
              isElectron ? '' : 'opacity-40'
            }`}
          >
            {t('live.systemAudio')}
          </button>
        </div>

        {active ? (
          <div className="sc-statbar text-xs">
            <span className="sc-statchip">
              <span className="sc-statchip__label">STT</span>
              <span className="sc-statchip__value">{t('live.localWhisper')}</span>
            </span>
            <span className="sc-statchip">
              <span className="sc-statchip__label">{t('live.modeLabel')}</span>
              <span className="sc-statchip__value">{mode === 'fast' ? t('live.fast') : t('live.stable')}</span>
            </span>
            <span className="sc-statchip">
              <span className="sc-statchip__label">{t('live.langLabel')}</span>
              <span className="sc-statchip__value uppercase">{language}</span>
            </span>
          </div>
        ) : (
          <>
            <div className="sc-segmented" role="group" aria-label={t('live.recModeAria')}>
              {(['fast', 'stable'] as SttMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onModeChange(m)}
                  title={m === 'fast' ? t('live.fastTitle') : t('live.stableTitle')}
                  className={`sc-segmented__item ${mode === m ? 'sc-segmented__item--active' : ''}`}
                >
                  {m === 'fast' ? t('live.fast') : t('live.stable')}
                </button>
              ))}
            </div>
            <select
              value={language}
              onChange={(e) => onLanguageChange(e.target.value)}
              className="select-compact min-w-[120px]"
            >
              <option value="ru">{t('settings.stt.optRu')}</option>
              <option value="multi">{t('settings.stt.optAuto')}</option>
              <option value="en">{t('settings.stt.optEn')}</option>
            </select>
          </>
        )}

        <details className="sc-live-more">
          <summary>{t('live.diagnostics')}</summary>
          <div className="sc-live-more__panel">
            <Metric label="STT" value={secs(sttMs)} />
            <Metric label="LLM" value={secs(llmMs)} />
            <Metric label={t('live.total')} value={secs(totalMs)} accent />
            {/* Инженерная опция — обычному пользователю не нужна в тулбаре. */}
            {!active && (
              <select
                value={audioRate}
                onChange={(e) => onAudioRateChange(e.target.value as AudioSampleRateMode)}
                title={t('live.audioFormatTitle')}
                className="select-compact min-w-[140px]"
              >
                {(Object.keys(AUDIO_RATE_LABELS) as AudioSampleRateMode[]).map((id) => (
                  <option key={id} value={id}>
                    {AUDIO_RATE_LABELS[id]}
                  </option>
                ))}
              </select>
            )}
          </div>
        </details>

        {utilities && (
          <details className="sc-live-more ml-auto">
            <summary>{t('live.more')}</summary>
            <div className="sc-live-more__panel sc-live-more__panel--stack">{utilities}</div>
          </details>
        )}
      </div>
    </div>
  );
}
