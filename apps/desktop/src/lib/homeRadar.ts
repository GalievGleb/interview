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

export type HomeHhAction = 'screening' | 'open-hh' | 'queue' | 'start';

export interface HomeHhCommandInput {
  running: boolean;
  queued: number;
  pendingQuestions: number;
  loginRequired: boolean;
  persistentVerification: boolean;
}

export interface HomeHhCommand {
  eyebrow: string;
  title: string;
  action: HomeHhAction;
  actionLabel: string;
}

export type HomeJourneyStepStatus = 'done' | 'current' | 'upcoming';

export interface HomeQuickAction {
  id: 'vacancies' | 'resume' | 'interview';
  label: string;
  detail: string;
  to: string;
}

export function getHomeJourneyProgress(steps: readonly HomeJourneyStepStatus[]): number {
  if (steps.length === 0) return 0;
  const done = steps.filter((status) => status === 'done').length;
  return Math.round((done / steps.length) * 100);
}

export function getHomeQuickActions(): HomeQuickAction[] {
  return [
    {
      id: 'vacancies',
      label: 'Найти вакансии',
      detail: 'Подобрать новые предложения',
      to: '/applications?mode=settings',
    },
    {
      id: 'resume',
      label: 'Анализ резюме',
      detail: 'Улучшить резюме под вакансию',
      to: '/documents',
    },
    {
      id: 'interview',
      label: 'Подготовиться к интервью',
      detail: 'Практика и ответы на вопросы',
      to: '/practice',
    },
  ];
}

function employerQuestionLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'вопросов работодателей';
  if (mod10 === 1) return 'вопрос работодателя';
  if (mod10 >= 2 && mod10 <= 4) return 'вопроса работодателей';
  return 'вопросов работодателей';
}

export function getHomeHhCommand(input: HomeHhCommandInput): HomeHhCommand {
  if (input.pendingQuestions > 0) {
    return {
      eyebrow: 'ТРЕБУЕТСЯ ОТВЕТ',
      title: `Ответьте на ${input.pendingQuestions} ${employerQuestionLabel(input.pendingQuestions)}`,
      action: 'screening',
      actionLabel: 'Открыть вопросы',
    };
  }
  if (input.loginRequired || input.persistentVerification) {
    return {
      eyebrow: 'НУЖЕН ВХОД В HH',
      title: 'Восстановите фоновую сессию HH',
      action: 'open-hh',
      actionLabel: 'Открыть HH',
    };
  }
  if (input.running) {
    return {
      eyebrow: 'АВТООТКЛИКИ РАБОТАЮТ',
      title: 'SkillCue проверяет новые вакансии',
      action: 'queue',
      actionLabel: 'Смотреть очередь',
    };
  }
  if (input.queued > 0) {
    return {
      eyebrow: 'ГОТОВО К ОТПРАВКЕ',
      title: `${input.queued} вакансий ждут обработки`,
      action: 'queue',
      actionLabel: 'Открыть автоочередь',
    };
  }
  return {
    eyebrow: 'ПОИСК ГОТОВ',
    title: 'Найдите новые подходящие вакансии',
    action: 'start',
    actionLabel: 'Запустить сейчас',
  };
}

export function isInterviewStartingSoon(
  startAt: string | undefined,
  now = new Date(),
  thresholdMs = 2 * 60 * 60 * 1_000,
): boolean {
  if (!startAt) return false;
  const starts = new Date(startAt).getTime();
  const delay = starts - now.getTime();
  return Number.isFinite(starts) && delay >= 0 && delay <= thresholdMs;
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
