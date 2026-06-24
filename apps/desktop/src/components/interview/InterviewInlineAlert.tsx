import type { ReactNode } from 'react';

type AlertTone = 'warn' | 'info' | 'error';

const TONE_CLASS: Record<AlertTone, string> = {
  warn: 'cockpit-alert-warn',
  info: 'cockpit-alert-info',
  error: 'cockpit-alert-error',
};

interface InterviewInlineAlertProps {
  tone: AlertTone;
  children: ReactNode;
}

export default function InterviewInlineAlert({ tone, children }: InterviewInlineAlertProps) {
  return <div className={`cockpit-alert ${TONE_CLASS[tone]}`}>{children}</div>;
}
