import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type InterviewType = 'hr' | 'technical' | 'other';
export type InterviewStatus = 'proposed' | 'confirmed' | 'cancelled';
export type SchedulingStage =
  | 'needs_availability'
  | 'needs_attention'
  | 'awaiting_recruiter'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'cancelled';

export interface AvailabilityWindow {
  id: string;
  weekday: number;
  startMinutes: number;
  endMinutes: number;
}

export interface InterviewCalendarSettings {
  availabilityConfigured: boolean;
  availability: AvailabilityWindow[];
  defaultDurationMin: number;
  minimumNoticeMin: number;
  timezone: string;
}

export interface InterviewOutcome {
  sessionId: string;
  headline: string;
  facts: string[];
  conditions: string[];
  nextSteps: string[];
  openQuestions: string[];
  createdAt: string;
}

export interface InterviewCalendarEvent {
  id: string;
  negotiationKey?: string;
  /** Stable path across HR, technical and final calls for the same vacancy. */
  journeyId?: string;
  vacancyTitle: string;
  companyName: string;
  type: InterviewType;
  status: InterviewStatus;
  startAt: string;
  endAt: string;
  source: 'hh' | 'manual';
  vacancyUrl?: string;
  vacancyDescription?: string;
  meetingUrl?: string;
  notes?: string;
  sessionId?: string;
  completedAt?: string;
  outcome?: InterviewOutcome;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewSchedulingThread {
  id: string;
  negotiationKey: string;
  vacancyTitle: string;
  companyName: string;
  type: InterviewType;
  stage: SchedulingStage;
  offeredSlots: string[];
  selectedStartAt?: string;
  recruiterMessage: string;
  reason?: string;
  hidden?: boolean;
  updatedAt: string;
}

export interface InterviewCalendarState {
  settings: InterviewCalendarSettings;
  events: InterviewCalendarEvent[];
  scheduling: InterviewSchedulingThread[];
}

interface DateToken {
  index: number;
  date: Date;
}

interface TimeToken {
  index: number;
  hour: number;
  minute: number;
}

export interface InterviewMessageAnalysis {
  isSchedulingMessage: boolean;
  type: InterviewType;
  slots: Date[];
  isConfirmation: boolean;
  isCancellation: boolean;
  meetingUrl?: string;
}

// The overlay may be opened shortly before a scheduled call for a microphone or
// screen check. A session started much earlier is a practice session and must not
// complete (and consequently hide) the future calendar event.
export const INTERVIEW_SESSION_EARLY_WINDOW_MS = 2 * 60 * 60 * 1000;

export function canLinkSessionToInterview(
  event: Pick<InterviewCalendarEvent, 'startAt'>,
  now = new Date(),
): boolean {
  const startAt = Date.parse(event.startAt);
  const nowAt = now.getTime();
  return Number.isFinite(startAt)
    && Number.isFinite(nowAt)
    && nowAt >= startAt - INTERVIEW_SESSION_EARLY_WINDOW_MS;
}

function repairPrematureInterviewOutcome(event: InterviewCalendarEvent): InterviewCalendarEvent {
  if (!event.completedAt) return event;
  const completedAt = Date.parse(event.completedAt);
  const startAt = Date.parse(event.startAt);
  if (
    !Number.isFinite(completedAt)
    || !Number.isFinite(startAt)
    || completedAt >= startAt - INTERVIEW_SESSION_EARLY_WINDOW_MS
  ) {
    return event;
  }

  const scheduledEvent = { ...event };
  delete scheduledEvent.sessionId;
  delete scheduledEvent.completedAt;
  delete scheduledEvent.outcome;
  return scheduledEvent;
}

const MONTHS: Record<string, number> = {
  январ: 0,
  феврал: 1,
  март: 2,
  апрел: 3,
  май: 4,
  мая: 4,
  июн: 5,
  июл: 6,
  август: 7,
  сентябр: 8,
  октябр: 9,
  ноябр: 10,
  декабр: 11,
};

const WEEKDAYS: Record<string, number> = {
  воскрес: 0,
  понедель: 1,
  вторник: 2,
  сред: 3,
  четвер: 4,
  пятниц: 5,
  суббот: 6,
};

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
}

export function defaultInterviewCalendarSettings(): InterviewCalendarSettings {
  return {
    availabilityConfigured: false,
    availability: [],
    defaultDurationMin: 60,
    minimumNoticeMin: 24 * 60,
    timezone: localTimezone(),
  };
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, amount: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + amount);
  return result;
}

function nextWeekday(now: Date, weekday: number): Date {
  const current = now.getDay();
  const delta = ((weekday - current + 7) % 7) || 7;
  return addDays(startOfDay(now), delta);
}

function monthFromWord(value: string): number | null {
  const lower = value.toLocaleLowerCase('ru');
  const entry = Object.entries(MONTHS).find(([stem]) => lower.startsWith(stem));
  return entry?.[1] ?? null;
}

function collectDateTokens(text: string, now: Date): DateToken[] {
  const result: DateToken[] = [];
  const lower = text.toLocaleLowerCase('ru');
  const relative = [
    { re: /послезавтра/g, days: 2 },
    { re: /(?<!после)завтра/g, days: 1 },
    { re: /сегодня/g, days: 0 },
  ];
  for (const item of relative) {
    for (const match of lower.matchAll(item.re)) {
      result.push({ index: match.index ?? 0, date: addDays(startOfDay(now), item.days) });
    }
  }

  const numeric = /\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/g;
  for (const match of lower.matchAll(numeric)) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    let year = match[3] ? Number(match[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    const date = new Date(year, month, day);
    if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) {
      if (!match[3] && date < startOfDay(now)) date.setFullYear(year + 1);
      result.push({ index: match.index ?? 0, date });
    }
  }

  const monthName = /(\d{1,2})\s+(январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|август[а]?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])(?:\s+(\d{4}))?/g;
  for (const match of lower.matchAll(monthName)) {
    const month = monthFromWord(match[2]);
    if (month == null) continue;
    const day = Number(match[1]);
    const year = match[3] ? Number(match[3]) : now.getFullYear();
    const date = new Date(year, month, day);
    if (!match[3] && date < startOfDay(now)) date.setFullYear(year + 1);
    result.push({ index: match.index ?? 0, date });
  }

  const weekdayPattern = /(воскресен(?:ье|ия)|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау])/g;
  for (const match of lower.matchAll(weekdayPattern)) {
    const word = match[1];
    const entry = Object.entries(WEEKDAYS).find(([stem]) => word.startsWith(stem));
    if (entry) result.push({ index: match.index ?? 0, date: nextWeekday(now, entry[1]) });
  }
  return result.sort((left, right) => left.index - right.index);
}

function collectTimeTokens(text: string): TimeToken[] {
  const result: TimeToken[] = [];
  const occupied = new Set<number>();
  const exact = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g;
  for (const match of text.matchAll(exact)) {
    const index = match.index ?? 0;
    result.push({ index, hour: Number(match[1]), minute: Number(match[2]) });
    for (let cursor = index; cursor < index + match[0].length; cursor += 1) occupied.add(cursor);
  }

  const afterPreposition = /(?:^|[\s,;])(?:в|к)\s+([01]?\d|2[0-3])(?:\s*(?:ч(?:ас(?:а|ов)?)?))?\b/gi;
  for (const match of text.matchAll(afterPreposition)) {
    const fullIndex = match.index ?? 0;
    const hourIndex = fullIndex + match[0].lastIndexOf(match[1]);
    if (occupied.has(hourIndex)) continue;
    result.push({ index: hourIndex, hour: Number(match[1]), minute: 0 });
  }
  return result.sort((left, right) => left.index - right.index);
}

export function parseInterviewSlots(text: string, now = new Date()): Date[] {
  const dates = collectDateTokens(text, now);
  // «10.08» — дата, а не время 10:08. Точечную запись времени (15.30)
  // сохраняем, когда она не совпала с началом валидной календарной даты.
  const times = collectTimeTokens(text).filter(
    (time) => !dates.some((date) => date.index === time.index),
  );
  if (dates.length === 0 || times.length === 0) return [];

  const unique = new Map<number, Date>();
  for (const time of times) {
    const preceding = dates.filter((date) => date.index <= time.index).at(-1);
    const nearest = preceding ?? dates[0];
    const value = new Date(
      nearest.date.getFullYear(),
      nearest.date.getMonth(),
      nearest.date.getDate(),
      time.hour,
      time.minute,
    );
    if (value.getTime() >= now.getTime() - 5 * 60_000) unique.set(value.getTime(), value);
  }
  return [...unique.values()].sort((left, right) => left.getTime() - right.getTime());
}

export function detectInterviewType(text: string): InterviewType {
  const lower = text.toLocaleLowerCase('ru');
  if (/(?:тех(?:ническ|ничк)|technical|тимлид|team\s*lead|руководител|архитектор)/i.test(lower)) {
    return 'technical';
  }
  if (/(?:\bhr\b|эйчар|рекрутер|первичн|знакомств)/i.test(lower)) return 'hr';
  return 'other';
}

export function analyzeInterviewMessage(text: string, now = new Date()): InterviewMessageAnalysis {
  const lower = text.toLocaleLowerCase('ru');
  const slots = parseInterviewSlots(text, now);
  const schedulingTopic = /собесед|интервью|созвон|встреч|звонок|пообщаться|этап отбора|техничк|техническ/i.test(lower);
  const schedulingAction = /когда|время|дата|удоб|подойд|сможете|давайте|назнач|перенес|отмен|подтверж|договор|жд[её]м|приглаша/i.test(lower);
  const implicitSlotQuestion = slots.length > 0 && /удоб|подойд|сможете|давайте|жд[её]м|подтверж/i.test(lower);
  const isConfirmation = /договорились|подтвержда|тогда\s+(?:жд[её]м|до встречи)|встреча\s+(?:назначена|состоится)|запланировали|зафиксировали|отлично,?\s+тогда|(?:давайте|подходит)\s+(?:перв|втор|трет|[123])|(?:перв|втор|трет|[123])(?:ый|ой|ий|-?й)?\s+вариант/i.test(lower);
  const isCancellation = /отмен(?:а|яем|или|яется)|не состоится|ваканси[яю]\s+закрыли|переносим без новой даты/i.test(lower);
  const meetingUrl = text.match(/https?:\/\/[^\s<>()]+/i)?.[0]?.replace(/[.,!?]+$/, '');
  return {
    isSchedulingMessage: (schedulingTopic && (schedulingAction || slots.length > 0)) || implicitSlotQuestion || isConfirmation || isCancellation,
    type: detectInterviewType(text),
    slots,
    isConfirmation,
    isCancellation,
    meetingUrl,
  };
}

function overlaps(start: Date, end: Date, event: InterviewCalendarEvent): boolean {
  if (event.status === 'cancelled') return false;
  return start < new Date(event.endAt) && end > new Date(event.startAt);
}

export function isInterviewSlotAvailable(
  start: Date,
  settings: InterviewCalendarSettings,
  events: InterviewCalendarEvent[],
  durationMin = settings.defaultDurationMin,
  now = new Date(),
  ignoreEventId?: string,
): boolean {
  if (!settings.availabilityConfigured || settings.availability.length === 0) return false;
  if (start.getTime() < now.getTime() + settings.minimumNoticeMin * 60_000) return false;
  const end = new Date(start.getTime() + durationMin * 60_000);
  if (start.toDateString() !== end.toDateString()) return false;
  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const endMinutes = end.getHours() * 60 + end.getMinutes();
  const insideWindow = settings.availability.some(
    (window) =>
      window.weekday === start.getDay() &&
      startMinutes >= window.startMinutes &&
      endMinutes <= window.endMinutes,
  );
  if (!insideWindow) return false;
  return !events.some((event) => event.id !== ignoreEventId && overlaps(start, end, event));
}

function ceilToHalfHour(value: Date): Date {
  const result = new Date(value);
  result.setSeconds(0, 0);
  const minutes = result.getMinutes();
  result.setMinutes(minutes <= 30 ? (minutes === 0 ? 0 : 30) : 60);
  return result;
}

export function findNextInterviewSlots(
  settings: InterviewCalendarSettings,
  events: InterviewCalendarEvent[],
  now = new Date(),
  count = 3,
): Date[] {
  if (!settings.availabilityConfigured) return [];
  const earliest = ceilToHalfHour(new Date(now.getTime() + settings.minimumNoticeMin * 60_000));
  const result: Date[] = [];
  for (let offset = 0; offset < 28 && result.length < count; offset += 1) {
    const day = addDays(startOfDay(earliest), offset);
    const windows = settings.availability
      .filter((window) => window.weekday === day.getDay())
      .sort((left, right) => left.startMinutes - right.startMinutes);
    for (const window of windows) {
      const windowStart = new Date(day);
      windowStart.setMinutes(window.startMinutes);
      let cursor = ceilToHalfHour(new Date(Math.max(windowStart.getTime(), earliest.getTime())));
      const windowEnd = new Date(day);
      windowEnd.setMinutes(window.endMinutes);
      while (
        cursor.getTime() + settings.defaultDurationMin * 60_000 <= windowEnd.getTime() &&
        result.length < count
      ) {
        if (isInterviewSlotAvailable(cursor, settings, events, settings.defaultDurationMin, now)) {
          result.push(new Date(cursor));
          break;
        }
        cursor = new Date(cursor.getTime() + 30 * 60_000);
      }
    }
  }
  return result;
}

/**
 * Recruiter-facing alternatives prefer real free time today and tomorrow.
 * We first take one option from each day (when available), then fill the
 * remaining choices from those two days and finally fall back to later dates.
 */
export function findRecruiterInterviewSlots(
  settings: InterviewCalendarSettings,
  events: InterviewCalendarEvent[],
  now = new Date(),
  count = 3,
): Date[] {
  if (!settings.availabilityConfigured || count <= 0) return [];
  const earliest = ceilToHalfHour(new Date(now.getTime() + settings.minimumNoticeMin * 60_000));
  const spacingMin = Math.max(60, settings.defaultDurationMin);
  const collectDaySlots = (day: Date): Date[] => {
    const daySlots: Date[] = [];
    const windows = settings.availability
      .filter((window) => window.weekday === day.getDay())
      .sort((left, right) => left.startMinutes - right.startMinutes);
    for (const window of windows) {
      const windowStart = new Date(day);
      windowStart.setMinutes(window.startMinutes);
      const windowEnd = new Date(day);
      windowEnd.setMinutes(window.endMinutes);
      let cursor = ceilToHalfHour(new Date(Math.max(windowStart.getTime(), earliest.getTime())));
      while (cursor.getTime() + settings.defaultDurationMin * 60_000 <= windowEnd.getTime()) {
        if (isInterviewSlotAvailable(cursor, settings, events, settings.defaultDurationMin, now)) {
          daySlots.push(new Date(cursor));
          cursor = new Date(cursor.getTime() + spacingMin * 60_000);
        } else {
          cursor = new Date(cursor.getTime() + 30 * 60_000);
        }
      }
    }
    return [...new Map(daySlots.map((slot) => [slot.getTime(), slot])).values()];
  };
  const nearDays = [0, 1].map((offset) =>
    collectDaySlots(addDays(startOfDay(now), offset)),
  );

  const chosen = new Map<number, Date>();
  for (const daySlots of nearDays) {
    const first = daySlots[0];
    if (first) chosen.set(first.getTime(), first);
    if (chosen.size >= count) break;
  }
  const remainingNear = nearDays
    .flatMap((daySlots) => daySlots.slice(1))
    .sort((left, right) => left.getTime() - right.getTime());
  for (const slot of remainingNear) {
    if (chosen.size >= count) break;
    chosen.set(slot.getTime(), slot);
  }

  if (chosen.size < count) {
    for (let offset = 2; offset < 28 && chosen.size < count; offset += 1) {
      const laterDay = collectDaySlots(addDays(startOfDay(now), offset));
      for (const slot of laterDay) {
        if (chosen.size >= count) break;
        chosen.set(slot.getTime(), slot);
      }
    }
  }
  return [...chosen.values()]
    .sort((left, right) => left.getTime() - right.getTime())
    .slice(0, count);
}

function interviewTimezoneSuffix(timezone: string, value: Date): string {
  try {
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(value).find((part) => part.type === 'timeZoneName')?.value
      .replace('GMT', 'UTC') ?? timezone;
    const rawCity = timezone.split('/').at(-1)?.replace(/_/g, ' ') ?? timezone;
    const city = rawCity === 'Krasnoyarsk' ? 'Красноярск'
      : rawCity === 'Moscow' ? 'Москва'
        : rawCity;
    return ` (${offset}, ${city})`;
  } catch {
    return ` (${timezone})`;
  }
}

function dateKeyInTimezone(value: Date, timezone?: string): string {
  if (!timezone) return `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

export function formatInterviewSlotRu(value: Date, timezone?: string): string {
  const formatted = new Intl.DateTimeFormat('ru-RU', {
    ...(timezone ? { timeZone: timezone } : {}),
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(value)
    .replace(',', ' в');
  return `${formatted}${timezone ? interviewTimezoneSuffix(timezone, value) : ''}`;
}

export function formatRecruiterInterviewSlotRu(value: Date, now = new Date(), timezone?: string): string {
  const time = new Intl.DateTimeFormat('ru-RU', {
    ...(timezone ? { timeZone: timezone } : {}),
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
  const suffix = timezone ? interviewTimezoneSuffix(timezone, value) : '';
  if (dateKeyInTimezone(value, timezone) === dateKeyInTimezone(now, timezone)) return `сегодня в ${time}${suffix}`;
  if (dateKeyInTimezone(value, timezone) === dateKeyInTimezone(addDays(now, 1), timezone)) {
    return `завтра в ${time}${suffix}`;
  }
  return formatInterviewSlotRu(value, timezone);
}

export function chooseThreadSlot(text: string, offeredSlots: string[]): Date | null {
  if (offeredSlots.length === 0) return null;
  const lower = text.toLocaleLowerCase('ru');
  const ordinal = /(?:перв|1[- ]?й)/.test(lower)
    ? 0
    : /(?:втор|2[- ]?й)/.test(lower)
      ? 1
      : /(?:трет|3[- ]?й)/.test(lower)
        ? 2
        : -1;
  if (ordinal >= 0 && offeredSlots[ordinal]) return new Date(offeredSlots[ordinal]);
  if (offeredSlots.length === 1 || /подходит|соглас|давайте|договорились|отлично/i.test(lower)) {
    return new Date(offeredSlots[0]);
  }
  return null;
}

function statePath(userDataDir: string): string {
  return path.join(userDataDir, 'interview-calendar.json');
}

function cloneState(state: InterviewCalendarState): InterviewCalendarState {
  return JSON.parse(JSON.stringify(state)) as InterviewCalendarState;
}

function normalizeSettings(
  previous: InterviewCalendarSettings,
  partial: Partial<InterviewCalendarSettings>,
): InterviewCalendarSettings {
  const availability = (partial.availability ?? previous.availability)
    .filter(
      (window) =>
        Number.isInteger(window.weekday) &&
        window.weekday >= 0 &&
        window.weekday <= 6 &&
        window.startMinutes >= 0 &&
        window.endMinutes <= 24 * 60 &&
        window.endMinutes > window.startMinutes,
    )
    .map((window, index) => ({
      id: String(window.id || `window-${window.weekday}-${index}`),
      weekday: window.weekday,
      startMinutes: Math.round(window.startMinutes),
      endMinutes: Math.round(window.endMinutes),
    }));
  return {
    availability,
    availabilityConfigured: partial.availabilityConfigured ?? availability.length > 0,
    defaultDurationMin: Math.min(240, Math.max(15, Math.round(partial.defaultDurationMin ?? previous.defaultDurationMin))),
    minimumNoticeMin: Math.min(14 * 24 * 60, Math.max(0, Math.round(partial.minimumNoticeMin ?? previous.minimumNoticeMin))),
    timezone: String(partial.timezone ?? previous.timezone ?? localTimezone()).slice(0, 100),
  };
}

export class InterviewCalendarStore {
  private state: InterviewCalendarState;

  constructor(
    private readonly userDataDir: string,
    private readonly onChange?: (state: InterviewCalendarState) => void,
  ) {
    this.state = this.load();
    const repairedEvents = this.state.events.map(repairPrematureInterviewOutcome);
    if (repairedEvents.some((event, index) => event !== this.state.events[index])) {
      this.state.events = repairedEvents;
      this.persist();
    }
  }

  getState(): InterviewCalendarState {
    return cloneState(this.state);
  }

  getSettings(): InterviewCalendarSettings {
    return { ...this.state.settings, availability: this.state.settings.availability.map((item) => ({ ...item })) };
  }

  getThread(negotiationKey: string): InterviewSchedulingThread | undefined {
    const thread = this.state.scheduling.find((item) => item.negotiationKey === negotiationKey);
    return thread ? { ...thread, offeredSlots: [...thread.offeredSlots] } : undefined;
  }

  getEvent(id: string): InterviewCalendarEvent | undefined {
    const event = this.state.events.find((item) => item.id === id);
    return event ? cloneState({ settings: this.state.settings, events: [event], scheduling: [] }).events[0] : undefined;
  }

  saveSettings(partial: Partial<InterviewCalendarSettings>): InterviewCalendarState {
    this.state.settings = normalizeSettings(this.state.settings, partial);
    this.commit();
    return this.getState();
  }

  upsertEvent(
    input: Omit<InterviewCalendarEvent, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): InterviewCalendarState {
    const now = new Date().toISOString();
    const existing = input.id
      ? this.state.events.find((item) => item.id === input.id)
      : input.negotiationKey
        ? this.state.events.find((item) => item.negotiationKey === input.negotiationKey && item.status !== 'cancelled')
        : undefined;
    const id = existing?.id ?? input.id ?? `interview-${crypto.randomUUID()}`;
    const normalizedVacancyUrl = input.vacancyUrl?.trim();
    const related = this.state.events
      .filter((event) => event.id !== id && event.status !== 'cancelled')
      .filter((event) => {
        if (normalizedVacancyUrl && event.vacancyUrl?.trim() === normalizedVacancyUrl) return true;
        return event.companyName.trim().toLocaleLowerCase('ru') === input.companyName.trim().toLocaleLowerCase('ru')
          && event.vacancyTitle.trim().toLocaleLowerCase('ru') === input.vacancyTitle.trim().toLocaleLowerCase('ru');
      })
      .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt))[0];
    const next: InterviewCalendarEvent = {
      ...existing,
      ...input,
      id,
      journeyId: input.journeyId ?? existing?.journeyId ?? related?.journeyId ?? related?.id ?? id,
      // A journey may contain HR, technical and final calls. They share the
      // vacancy context, but every real call keeps its own recording/session.
      sessionId: input.sessionId ?? existing?.sessionId,
      vacancyUrl: normalizedVacancyUrl || existing?.vacancyUrl || related?.vacancyUrl,
      vacancyDescription: input.vacancyDescription?.trim() || existing?.vacancyDescription || related?.vacancyDescription,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.state.events = existing
      ? this.state.events.map((item) => (item.id === existing.id ? next : item))
      : [...this.state.events, next];
    if (next.negotiationKey) {
      this.state.scheduling = this.state.scheduling.map((thread) =>
        thread.negotiationKey === next.negotiationKey
          ? {
              ...thread,
              stage: next.status === 'confirmed' ? 'confirmed' : thread.stage,
              selectedStartAt: next.startAt,
              updatedAt: now,
            }
          : thread,
      );
    }
    this.commit();
    return this.getState();
  }

  scheduleFromNegotiation(input: {
    negotiationKey: string;
    vacancyTitle: string;
    companyName: string;
    type: InterviewType;
    start: Date;
    status: Extract<InterviewStatus, 'proposed' | 'confirmed'>;
    meetingUrl?: string;
    notes?: string;
  }): InterviewCalendarState {
    const duration = this.state.settings.defaultDurationMin;
    return this.upsertEvent({
      negotiationKey: input.negotiationKey,
      vacancyTitle: input.vacancyTitle,
      companyName: input.companyName,
      type: input.type,
      status: input.status,
      startAt: input.start.toISOString(),
      endAt: new Date(input.start.getTime() + duration * 60_000).toISOString(),
      source: 'hh',
      meetingUrl: input.meetingUrl,
      notes: input.notes,
    });
  }

  cancelNegotiation(negotiationKey: string): InterviewCalendarState {
    const now = new Date().toISOString();
    this.state.events = this.state.events.map((event) =>
      event.negotiationKey === negotiationKey
        ? { ...event, status: 'cancelled' as const, updatedAt: now }
        : event,
    );
    const thread = this.getThread(negotiationKey);
    if (thread) this.upsertThread({ ...thread, stage: 'cancelled', updatedAt: now });
    else this.commit();
    return this.getState();
  }

  removeEvent(id: string): InterviewCalendarState {
    this.state.events = this.state.events.filter((item) => item.id !== id);
    this.commit();
    return this.getState();
  }

  attachSession(eventId: string, sessionId: string, currentTime = new Date()): InterviewCalendarState {
    const now = currentTime.toISOString();
    let changed = false;
    this.state.events = this.state.events.map((event) => {
      if (event.id !== eventId || !canLinkSessionToInterview(event, currentTime)) return event;
      changed = true;
      return { ...event, sessionId: sessionId.trim(), updatedAt: now };
    });
    if (changed) this.commit();
    return this.getState();
  }

  saveOutcome(eventId: string, outcome: InterviewOutcome, currentTime = new Date()): InterviewCalendarState {
    const now = currentTime.toISOString();
    let changed = false;
    this.state.events = this.state.events.map((event) => {
      if (event.id !== eventId || !canLinkSessionToInterview(event, currentTime)) return event;
      changed = true;
      return {
        ...event,
        sessionId: outcome.sessionId,
        completedAt: now,
        outcome: {
          ...outcome,
          facts: [...outcome.facts],
          conditions: [...outcome.conditions],
          nextSteps: [...outcome.nextSteps],
          openQuestions: [...outcome.openQuestions],
        },
        updatedAt: now,
      };
    });
    if (changed) this.commit();
    return this.getState();
  }

  upsertThread(input: Omit<InterviewSchedulingThread, 'id' | 'updatedAt'> & { id?: string; updatedAt?: string }): InterviewCalendarState {
    const existing = this.state.scheduling.find((item) => item.negotiationKey === input.negotiationKey);
    const next: InterviewSchedulingThread = {
      ...existing,
      ...input,
      id: existing?.id ?? input.id ?? `scheduling-${crypto.createHash('sha1').update(input.negotiationKey).digest('hex').slice(0, 12)}`,
      offeredSlots: [...input.offeredSlots],
      hidden:
        input.hidden ??
        (existing?.recruiterMessage === input.recruiterMessage ? existing.hidden : false),
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    };
    this.state.scheduling = existing
      ? this.state.scheduling.map((item) => (item.id === existing.id ? next : item))
      : [...this.state.scheduling, next];
    this.state.scheduling = this.state.scheduling.slice(-100);
    this.commit();
    return this.getState();
  }

  dismissThread(id: string): InterviewCalendarState {
    this.state.scheduling = this.state.scheduling.map((item) =>
      item.id === id ? { ...item, hidden: true } : item,
    );
    this.commit();
    return this.getState();
  }

  private load(): InterviewCalendarState {
    const fallback: InterviewCalendarState = {
      settings: defaultInterviewCalendarSettings(),
      events: [],
      scheduling: [],
    };
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath(this.userDataDir), 'utf8')) as Partial<InterviewCalendarState>;
      return {
        settings: normalizeSettings(fallback.settings, parsed.settings ?? {}),
        events: Array.isArray(parsed.events) ? parsed.events : [],
        scheduling: Array.isArray(parsed.scheduling) ? parsed.scheduling : [],
      };
    } catch {
      return fallback;
    }
  }

  private commit(): void {
    this.persist();
    this.onChange?.(this.getState());
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(statePath(this.userDataDir)), { recursive: true });
      fs.writeFileSync(statePath(this.userDataDir), JSON.stringify(this.state, null, 2), 'utf8');
    } catch (error) {
      console.warn('[interview-calendar] persist failed:', error);
    }
  }
}
