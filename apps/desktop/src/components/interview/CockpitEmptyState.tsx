import type { ReactNode } from 'react';

interface CockpitEmptyStateProps {
  icon: ReactNode;
  title: string;
  hint?: string;
}

export default function CockpitEmptyState({ icon, title, hint }: CockpitEmptyStateProps) {
  return (
    <div className="cockpit-empty">
      <div className="cockpit-empty-icon">{icon}</div>
      <p className="text-sm font-medium text-ink-muted">{title}</p>
      {hint && <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
    </svg>
  );
}

export function TranscriptEmptyIcon() {
  return <MicIcon />;
}

export function AnswerEmptyIcon() {
  return <SparkIcon />;
}
