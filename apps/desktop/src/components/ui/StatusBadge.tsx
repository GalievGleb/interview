type StatusTone = 'idle' | 'listening' | 'processing' | 'success' | 'warning' | 'error';

const TONE_DOT: Record<StatusTone, string> = {
  idle: 'bg-ink-faint',
  listening: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]',
  processing: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.45)]',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
};

interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
  pulse?: boolean;
  className?: string;
}

export default function StatusBadge({
  label,
  tone = 'idle',
  pulse = false,
  className = '',
}: StatusBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-2 text-xs text-ink-muted ${className}`}>
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]} ${
          pulse ? 'animate-pulse' : ''
        }`}
      />
      <span>{label}</span>
    </span>
  );
}

export type LiveSessionStatus = 'idle' | 'listening' | 'processing' | 'answer_ready';

const LIVE_STATUS_LABEL: Record<LiveSessionStatus, string> = {
  idle: 'Ожидание',
  listening: 'Слушаю',
  processing: 'Обработка',
  answer_ready: 'Ответ готов',
};

const LIVE_STATUS_TONE: Record<LiveSessionStatus, StatusTone> = {
  idle: 'idle',
  listening: 'listening',
  processing: 'processing',
  answer_ready: 'success',
};

const LIVE_PING: Record<LiveSessionStatus, string> = {
  idle: '',
  listening: 'bg-emerald-400',
  processing: 'bg-amber-400',
  answer_ready: 'bg-accent',
};

const LIVE_PILL_TINT: Record<LiveSessionStatus, string> = {
  idle: '',
  listening: 'border-emerald-500/30 bg-emerald-500/10',
  processing: 'border-amber-500/30 bg-amber-500/10',
  answer_ready: 'border-accent/30 bg-accent-soft',
};

export function LiveStatusBadge({ status }: { status: LiveSessionStatus }) {
  const pulse = status === 'listening' || status === 'processing';
  return (
    <span className={`cockpit-status-pill ${LIVE_PILL_TINT[status]}`}>
      <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
        {pulse && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${LIVE_PING[status]}`}
          />
        )}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${TONE_DOT[LIVE_STATUS_TONE[status]]}`}
        />
      </span>
      <span className="text-xs font-medium text-ink">{LIVE_STATUS_LABEL[status]}</span>
    </span>
  );
}
