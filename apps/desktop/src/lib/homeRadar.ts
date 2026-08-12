function localDayKey(value: Date): string {
  return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
}

export interface HomeApplicationFlowInput {
  queued: number;
  sentToday: number;
  activeDialogs: number;
  running: boolean;
}

export interface HomeApplicationFlow {
  progress: number;
  reached: [boolean, boolean, boolean];
}

export function getHomeApplicationFlow({
  queued,
  sentToday,
  activeDialogs,
  running,
}: HomeApplicationFlowInput): HomeApplicationFlow {
  const dialogReached = activeDialogs > 0;
  const sentReached = sentToday > 0 || dialogReached;
  const queueReached = running || queued > 0 || sentReached;

  return {
    progress: dialogReached ? 100 : sentReached ? 50 : queueReached ? 8 : 0,
    reached: [queueReached, sentReached, dialogReached],
  };
}

export function isSameLocalDay(value: string | Date, now: Date): boolean {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) && localDayKey(date) === localDayKey(now);
}

function isTomorrow(value: Date, now: Date): boolean {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return localDayKey(value) === localDayKey(tomorrow);
}

function timeLabel(value: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function relativeDay(value: Date, now: Date): string {
  if (isSameLocalDay(value, now)) return 'сегодня';
  if (isTomorrow(value, now)) return 'завтра';
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(value);
}

export function formatHomeInterviewStart(value: string, now: Date): string {
  const date = new Date(value);
  return `${relativeDay(date, now)} в ${timeLabel(date)}`;
}

export function formatHomeInterviewBadge(value: string, now: Date): string {
  const date = new Date(value);
  return `${relativeDay(date, now).toLocaleUpperCase('ru-RU')} · ${timeLabel(date)}`;
}

export function formatHomeDate(now: Date): string {
  const label = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
  return label.charAt(0).toLocaleUpperCase('ru-RU') + label.slice(1);
}
