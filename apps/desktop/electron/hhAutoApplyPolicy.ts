import type { HhAssistantConfig } from './hhAssistantPolicy';

/** Возможные состояния страницы вакансии при отклике. */
export type HhApplySituation =
  | 'response_button'
  | 'resume_select'
  | 'letter_offer'
  | 'letter_form'
  | 'confirm'
  | 'success'
  | 'already_applied'
  | 'captcha'
  | 'employer_questions'
  | 'login'
  | 'unknown';

export interface HhApplyContext {
  hasCoverLetter: boolean;
  resumeTitleContains: string;
  /** IO-слой отмечает, что резюме уже выбрано в этой попытке. */
  resumeSelected: boolean;
  /** IO-слой отмечает, что письмо уже вставлено в этой попытке. */
  letterFilled: boolean;
}

export type HhApplyAction =
  | { action: 'click_response' }
  | { action: 'select_resume' }
  | { action: 'open_letter' }
  | { action: 'fill_letter' }
  | { action: 'click_confirm' }
  | { action: 'mark_sent' }
  | { action: 'skip'; reason: string }
  | { action: 'wait_user'; reason: string };

/** Чистая FSM: по состоянию страницы решает, что делать дальше. Без IO. */
export function decideNextAction(
  situation: HhApplySituation,
  ctx: HhApplyContext,
): HhApplyAction {
  switch (situation) {
    case 'success':
      return { action: 'mark_sent' };
    case 'already_applied':
      return { action: 'mark_sent' };
    case 'captcha':
      return {
        action: 'wait_user',
        reason: 'HH запросил проверку. Завершите её в открытом браузере и продолжите.',
      };
    case 'employer_questions':
      return {
        action: 'skip',
        reason: 'Вакансия требует ответы на вопросы или тест работодателя.',
      };
    case 'login':
      return {
        action: 'wait_user',
        reason: 'Сессия HH истекла. Войдите в открытом браузере.',
      };
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

/** Случайная пауза 0.6–1.4 от базовой, random инжектится ради тестов. */
export function jitterMs(baseSec: number, random: () => number = Math.random): number {
  const factor = 0.6 + random() * 0.8;
  return Math.max(1_000, Math.round(baseSec * factor * 1_000));
}
