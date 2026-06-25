import type { ReactNode } from 'react';
import { LiveSources } from '../../hooks/useLiveCopilot';
import { SttMode } from '../../lib/liveSession';
import { AUDIO_RATE_LABELS, AudioSampleRateMode } from '../../lib/sttOptions';
import { LiveSessionStatus, LiveStatusBadge } from '../ui/StatusBadge';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

export interface LiveControlsProps {
  active: boolean;
  status: LiveSessionStatus;
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
}

function TogglePill({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={onChange}
      className={`segmented-item ${checked ? 'segmented-item-active' : ''} ${
        disabled ? 'opacity-40' : ''
      }`}
    >
      {label}
    </button>
  );
}

function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cockpit-control-group">
      <span className="cockpit-control-label">{label}</span>
      {children}
    </div>
  );
}

export default function LiveControls({
  active,
  status,
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
}: LiveControlsProps) {
  return (
    <div className="cockpit-toolbar">
      <div className="cockpit-toolbar-row">
        <LiveStatusBadge status={status} />

        <div className="segmented">
          <TogglePill
            checked={sources.mic}
            onChange={() => onToggleSource('mic')}
            label="Microphone"
          />
          <TogglePill
            checked={sources.system}
            onChange={() => onToggleSource('system')}
            label="System audio"
            disabled={!isElectron}
            title={isElectron ? undefined : 'Desktop app only'}
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {active ? (
            <button type="button" onClick={onStop} className="btn-danger btn-sm">
              Stop Live
            </button>
          ) : (
            <button
              type="button"
              onClick={onStart}
              disabled={!canStart || !hasStt || noSource}
              title={!hasStt ? 'Download a local speech model in Settings → Speech Recognition' : undefined}
              className="btn-primary min-w-[120px]"
            >
              Start Live
            </button>
          )}
        </div>
      </div>

      {!active && (
        <div className="cockpit-toolbar-row">
          <ControlGroup label="Mode">
            <div className="segmented" role="group" aria-label="STT mode">
              {(['fast', 'stable'] as SttMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onModeChange(m)}
                  title={
                    m === 'fast'
                      ? 'Faster, weaker on technical terms'
                      : 'More accurate STT (+~0.3s, recommended)'
                  }
                  className={`segmented-item ${mode === m ? 'segmented-item-active' : ''}`}
                >
                  {m === 'fast' ? 'Fast' : 'Stable'}
                </button>
              ))}
            </div>
          </ControlGroup>

          <ControlGroup label="Audio">
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
          </ControlGroup>

          <ControlGroup label="Language">
            <select
              value={language}
              onChange={(e) => onLanguageChange(e.target.value)}
              className="select-compact min-w-[120px]"
            >
              <option value="ru">Russian</option>
              <option value="multi">Auto (ru+en)</option>
              <option value="en">English</option>
            </select>
          </ControlGroup>
        </div>
      )}
    </div>
  );
}
