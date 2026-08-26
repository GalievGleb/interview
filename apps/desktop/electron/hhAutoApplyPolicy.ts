import type { HhAssistantConfig } from './hhAssistantPolicy';

export const HH_VERIFICATION_COOLDOWN_MS = 2 * 60 * 60 * 1_000;

/** Возможные состояния страницы вакансии при отклике. */
export type HhApplySituation =
  | 'response_button'
  | 'resume_select'
  | 'letter_offer'
  | 'letter_form'
  | 'confirm'
  | 'success'
  | 'already_applied'
  | 'post_response_letter_offer'
  | 'captcha'
  | 'employer_questions'
  | 'login'
  | 'unavailable'
  | 'unknown';

export interface HhApplyContext {
  hasCoverLetter: boolean;
  resumeTitleContains: string;
  /** IO-слой отмечает, что резюме уже выбрано в этой попытке. */
  resumeSelected: boolean;
  /** IO-слой отмечает, что письмо уже вставлено в этой попытке. */
  letterFilled: boolean;
  /** IO-слой отмечает, что обязательные вопросы работодателя заполнены. */
  questionsFilled: boolean;
  /** В этой попытке уже нажимали первую кнопку отклика. */
  responseClicked: boolean;
  /** HH уже принял отклик, но ещё разрешает добавить письмо. */
  responseSubmitted: boolean;
}

export type HhApplyAction =
  | { action: 'click_response' }
  | { action: 'select_resume' }
  | { action: 'open_letter' }
  | { action: 'fill_letter' }
  | { action: 'fill_questions' }
  | { action: 'click_confirm' }
  | { action: 'mark_sent' }
  | { action: 'wait_letter'; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'wait_user'; reason: string };

export function isUnavailableHhVacancyText(value: string): boolean {
  return /вам\s+недоступна\s+эта\s+вакансия|вакансия\s+(?:больше\s+)?недоступна|вакансия\s+не\s+найдена|такой\s+вакансии\s+(?:уже\s+)?нет/i
    .test(value);
}

/** Чистая FSM: по состоянию страницы решает, что делать дальше. Без IO. */
export function decideNextAction(
  situation: HhApplySituation,
  ctx: HhApplyContext,
): HhApplyAction {
  switch (situation) {
    case 'success':
      return ctx.hasCoverLetter
        && !ctx.letterFilled
        && (ctx.responseClicked || ctx.responseSubmitted)
        ? {
            action: 'wait_letter',
            reason: 'Дожидаюсь формы сопроводительного письма; отклик пока не считаю завершённым.',
          }
        : { action: 'mark_sent' };
    case 'already_applied':
      return ctx.hasCoverLetter
        && !ctx.letterFilled
        && (ctx.responseClicked || ctx.responseSubmitted)
        ? {
            action: 'wait_letter',
            reason: 'Дожидаюсь формы сопроводительного письма; отклик пока не считаю завершённым.',
          }
        : { action: 'mark_sent' };
    case 'post_response_letter_offer':
      return ctx.hasCoverLetter && !ctx.letterFilled
        ? { action: 'open_letter' }
        : { action: 'mark_sent' };
    case 'captcha':
      return {
        action: 'wait_user',
        reason: 'HH запросил проверку. Завершите её в открытом браузере и продолжите.',
      };
    case 'employer_questions':
      return ctx.questionsFilled
        ? { action: 'click_confirm' }
        : { action: 'fill_questions' };
    case 'login':
      return {
        action: 'wait_user',
        reason: 'Сессия HH истекла. Войдите в открытом браузере.',
      };
    case 'unavailable':
      return { action: 'skip', reason: 'Вакансия больше недоступна на HH.' };
    case 'response_button':
      return { action: 'click_response' };
    case 'resume_select':
      return ctx.resumeTitleContains && !ctx.resumeSelected
        ? { action: 'select_resume' }
        : { action: 'click_confirm' };
    case 'letter_offer':
      return ctx.hasCoverLetter && !ctx.letterFilled
        ? { action: 'open_letter' }
        : { action: 'click_confirm' };
    case 'letter_form':
      return ctx.hasCoverLetter && !ctx.letterFilled
        ? { action: 'fill_letter' }
        : { action: 'click_confirm' };
    case 'confirm':
      return { action: 'click_confirm' };
    case 'unknown':
      return { action: 'skip', reason: 'Не удалось распознать состояние страницы HH.' };
  }
}

interface SentLike {
  status: string;
  sentAt?: string;
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Сколько откликов отправлено в текущие локальные сутки. */
export function countTodaySent(queue: SentLike[], now: Date = new Date()): number {
  let count = 0;
  for (const item of queue) {
    if (item.status !== 'sent' || !item.sentAt) continue;
    const sentAt = new Date(item.sentAt);
    if (Number.isNaN(sentAt.getTime())) continue;
    if (isSameLocalDay(sentAt, now)) count += 1;
  }
  return count;
}

export function canSendMore(
  config: Pick<HhAssistantConfig, 'dailyLimit'>,
  queue: SentLike[],
  now: Date = new Date(),
): boolean {
  return countTodaySent(queue, now) < config.dailyLimit;
}

/** Trial users may configure a smaller limit, but can never exceed 10 actual sends/day. */
export function effectiveDailyLimit(configured: number, plan: string | null | undefined): number {
  const safeConfigured = Math.max(1, Math.trunc(configured || 1));
  return plan === 'trial' ? Math.min(10, safeConfigured) : safeConfigured;
}

/** Сколько миллисекунд до ближайшего часа авто-прогона (сегодня или завтра). */
export function nextAutoRunDelayMs(
  config: Pick<HhAssistantConfig, 'autoRunHour'>,
  now: Date = new Date(),
): number {
  const next = new Date(now);
  next.setHours(config.autoRunHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * The configured hour starts a discovery window, not a single fragile alarm.
 * A missed start runs immediately; after a run we rescan every two hours until 22:00.
 */
export function nextDiscoveryRunDelayMs(
  config: Pick<HhAssistantConfig, 'autoRunHour'>,
  lastScheduledRunAt: string | undefined,
  now: Date = new Date(),
): number {
  const last = lastScheduledRunAt ? new Date(lastScheduledRunAt) : null;
  const ranToday = Boolean(last && !Number.isNaN(last.getTime()) && isSameLocalDay(last, now));
  if (now.getHours() >= config.autoRunHour && now.getHours() < 22) {
    return ranToday ? 2 * 60 * 60 * 1_000 : 5_000;
  }
  return nextAutoRunDelayMs(config, now);
}

/**
 * Search synonyms are independent, but multiplying every synonym by the full
 * page limit produces hundreds of back-to-back HH navigations. Spend one
 * global budget in round-robin order while always visiting each synonym once.
 */
export function hhDiscoveryPageBudget(queryCount: number, configuredMaxPages: number): number {
  const queries = Math.max(0, Math.trunc(queryCount || 0));
  if (queries === 0) return 0;
  const configured = Math.max(1, Math.trunc(configuredMaxPages || 1));
  return Math.max(queries, configured);
}

export function isFullyKnownDiscoveryPage(
  candidateKeys: readonly string[],
  knownKeys: ReadonlySet<string>,
): boolean {
  return candidateKeys.length > 0 && candidateKeys.every((key) => knownKeys.has(key));
}

export function hhVerificationCooldownUntil(now: Date = new Date()): string {
  return new Date(now.getTime() + HH_VERIFICATION_COOLDOWN_MS).toISOString();
}

export function isFutureIsoTimestamp(
  value: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

/** Случайная пауза 0.6–1.4 от базовой, random инжектится ради тестов. */
export function jitterMs(baseSec: number, random: () => number = Math.random): number {
  const factor = 0.6 + random() * 0.8;
  return Math.max(1_000, Math.round(baseSec * factor * 1_000));
}
