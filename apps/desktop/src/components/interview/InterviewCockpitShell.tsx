import type { ReactNode } from 'react';

interface InterviewCockpitShellProps {
  children: ReactNode;
}

/** Subtle dashboard background — scoped to Interview Copilot only. */
export default function InterviewCockpitShell({ children }: InterviewCockpitShellProps) {
  return (
    <div className="cockpit-root">
      <div className="cockpit-bg" aria-hidden>
        <div className="cockpit-bg-glow absolute inset-0" />
        <div className="cockpit-bg-grid absolute inset-0 opacity-60" />
      </div>
      <div className="cockpit-content">{children}</div>
    </div>
  );
}
