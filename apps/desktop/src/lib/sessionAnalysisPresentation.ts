export interface SessionEvidenceLayout {
  hasStrengths: boolean;
  hasWeaknesses: boolean;
  hasAny: boolean;
  isSplit: boolean;
}

export function resolveSessionEvidenceLayout(
  strengthCount: number,
  weaknessCount: number,
): SessionEvidenceLayout {
  const hasStrengths = strengthCount > 0;
  const hasWeaknesses = weaknessCount > 0;

  return {
    hasStrengths,
    hasWeaknesses,
    hasAny: hasStrengths || hasWeaknesses,
    isSplit: hasStrengths && hasWeaknesses,
  };
}

interface SessionTimeFormatOptions {
  locale?: string;
  timeZone?: string;
}

interface SessionTimeParts {
  dateKey: string;
  dateLabel: string;
  timeLabel: string;
}

const TIMEZONE_SUFFIX_RE = /(?:z|[+-]\d{2}:?\d{2})$/i;

function parseBackendUtcTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = new Date(TIMEZONE_SUFFIX_RE.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTimeParts(
  value: Date,
  locale: string,
  timeZone: string | undefined,
): SessionTimeParts {
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((part) => part.type === type)?.value ?? ''
  );
  const weekday = get('weekday').replace(/\.$/, '');
  const weekdayLabel = weekday
    ? `${weekday.charAt(0).toLocaleUpperCase(locale)}${weekday.slice(1)}`
    : '';
  const day = get('day');
  const month = get('month');
  const year = get('year');

  return {
    dateKey: `${year}-${month}-${day}`,
    dateLabel: `${weekdayLabel}, ${day}.${month}.${year}`,
    timeLabel: `${get('hour')}:${get('minute')}`,
  };
}

/**
 * Session timestamps are persisted as naive UTC by the local backend. Convert
 * them at the presentation boundary so History shows the user's local clock.
 */
export function formatSessionInterval(
  startedAt: string,
  endedAt: string | null,
  options: SessionTimeFormatOptions = {},
): string {
  const locale = options.locale ?? 'ru-RU';
  const started = parseBackendUtcTimestamp(startedAt);
  if (!started) return 'Время не указано';

  const start = formatTimeParts(started, locale, options.timeZone);
  const ended = endedAt ? parseBackendUtcTimestamp(endedAt) : null;
  if (!ended) return `${start.dateLabel} · с ${start.timeLabel}`;

  const end = formatTimeParts(ended, locale, options.timeZone);
  if (start.dateKey === end.dateKey) {
    return `${start.dateLabel} · ${start.timeLabel}–${end.timeLabel}`;
  }
  return `${start.dateLabel} · ${start.timeLabel} – ${end.dateLabel} · ${end.timeLabel}`;
}
