import { useEffect, useRef } from 'react';
import type { TranscriptLine } from '../../hooks/useLiveCopilot';
import SttDebugPanel, { SttDebugInfo } from '../SttDebugPanel';
import CockpitEmptyState, { TranscriptEmptyIcon } from './CockpitEmptyState';

interface InterviewTranscriptPanelProps {
  lines: TranscriptLine[];
  debug: SttDebugInfo | null;
  debugOpen: boolean;
  onDebugToggle: () => void;
  active: boolean;
}

export default function InterviewTranscriptPanel({
  lines,
  debug,
  debugOpen,
  onDebugToggle,
  active,
}: InterviewTranscriptPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div className="cockpit-panel flex min-h-0 flex-col lg:min-w-0 lg:flex-1">
      <div className="cockpit-panel-head">
        <h2 className="cockpit-panel-title">Live Transcript</h2>
        {lines.length > 0 && (
          <span className="rounded-full border border-surface-border bg-surface-elevated px-2 py-0.5 text-[10px] text-ink-faint">
            {lines.length} lines
          </span>
        )}
      </div>

      <div className="transcript-scroll min-h-0 flex-1 px-3 py-3">
        {lines.length === 0 && (
          <CockpitEmptyState
            icon={<TranscriptEmptyIcon />}
            title={active ? 'Listening…' : 'Start live session to capture interview questions'}
            hint="You and Interviewer are labeled with distinct colors."
          />
        )}

        <div className="space-y-2">
          {lines.map((line, i) => (
            <div
              key={i}
              className={`cockpit-transcript-item ${
                line.speaker === 'me' ? 'cockpit-transcript-me' : 'cockpit-transcript-other'
              }`}
            >
              <span className="transcript-speaker">
                {line.speaker === 'me' ? 'You' : 'Interviewer'}
              </span>
              <p className={`transcript-text ${line.isFinal ? '' : 'transcript-interim'}`}>
                {line.text}
              </p>
              {line.normalized && line.normalized !== line.text && (
                <p className="transcript-normalized">→ {line.normalized}</p>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <SttDebugPanel debug={debug} show={debugOpen} onToggle={onDebugToggle} />
    </div>
  );
}
