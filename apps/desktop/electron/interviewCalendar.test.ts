import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InterviewCalendarStore,
  analyzeInterviewMessage,
  canLinkSessionToInterview,
  chooseThreadSlot,
  findNextInterviewSlots,
  findNearestCurrentInterview,
  findRecruiterInterviewSlots,
  formatRecruiterInterviewSlotRu,
  isInterviewSlotAvailable,
  parseInterviewSlots,
  requestsCandidateInterviewAvailability,
  type InterviewCalendarEvent,
  type InterviewCalendarSettings,
  type InterviewCalendarState,
} from './interviewCalendar';

describe('overlay interview association', () => {
  it('selects the nearest confirmed call inside the live window', () => {
    const now = new Date('2026-08-20T16:00:00+07:00');
    const base = {
      vacancyTitle: 'QA', companyName: 'Acme', type: 'hr' as const,
      status: 'confirmed' as const, source: 'manual' as const,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    const events: InterviewCalendarEvent[] = [
      { ...base, id: 'later', startAt: '2026-08-20T16:40:00+07:00', endAt: '2026-08-20T17:10:00+07:00' },
      { ...base, id: 'now', startAt: '2026-08-20T16:00:00+07:00', endAt: '2026-08-20T16:30:00+07:00' },
      { ...base, id: 'cancelled', status: 'cancelled', startAt: '2026-08-20T16:00:00+07:00', endAt: '2026-08-20T16:30:00+07:00' },
    ];
    expect(findNearestCurrentInterview(events, now)?.id).toBe('now');
  });
});

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function settings(overrides: Partial<InterviewCalendarSettings> = {}): InterviewCalendarSettings {
  return {
    availabilityConfigured: true,
    availability: [
      { id: 'mon-am', weekday: 1, startMinutes: 10 * 60, endMinutes: 14 * 60 },
      { id: 'mon-pm', weekday: 1, startMinutes: 16 * 60, endMinutes: 19 * 60 },
    ],
    defaultDurationMin: 60,
    minimumNoticeMin: 0,
    timezone: 'Asia/Krasnoyarsk',
    ...overrides,
  };
}

describe('interview message parsing', () => {
  it('extracts a relative Russian date, time and technical stage', () => {
    const now = new Date(2026, 7, 6, 10, 0);
    const analysis = analyzeInterviewMessage(
      'Приглашаем на техническое интервью завтра в 15:30. Вам удобно?',
      now,
    );

    expect(analysis.isSchedulingMessage).toBe(true);
    expect(analysis.type).toBe('technical');
    expect(analysis.slots).toHaveLength(1);
    expect(analysis.slots[0].getDate()).toBe(7);
    expect(analysis.slots[0].getHours()).toBe(15);
    expect(analysis.slots[0].getMinutes()).toBe(30);
  });

  it('understands several recruiter alternatives', () => {
    const now = new Date(2026, 7, 6, 10, 0);
    const slots = parseInterviewSlots(
      'Можем в понедельник в 11:00 или во вторник в 17:00',
      now,
    );

    expect(slots).toHaveLength(2);
    expect(slots.map((slot) => slot.getHours())).toEqual([11, 17]);
  });

  it('does not confuse a dotted date with a time', () => {
    const now = new Date(2026, 7, 6, 10, 0);
    const slots = parseInterviewSlots('Встреча 10.08 в 15:00', now);
    expect(slots).toHaveLength(1);
    expect(slots[0].getDate()).toBe(10);
    expect(slots[0].getHours()).toBe(15);
    expect(slots[0].getMinutes()).toBe(0);
  });

  it('recognizes an ordinal answer as confirmation of a previous option', () => {
    const analysis = analyzeInterviewMessage('Отлично, давайте второй вариант');
    expect(analysis.isSchedulingMessage).toBe(true);
    expect(analysis.isConfirmation).toBe(true);
  });

  it('does not treat an ordinary recruiter question as scheduling', () => {
    const analysis = analyzeInterviewMessage('Расскажите, пожалуйста, о вашем опыте с Playwright.');
    expect(analysis.isSchedulingMessage).toBe(false);
  });

  it('offers own slots only after an explicit request for candidate availability', () => {
    expect(requestsCandidateInterviewAvailability(
      'Приглашаем вас на техническое интервью. Будем рады знакомству!',
    )).toBe(false);
    expect(requestsCandidateInterviewAvailability(
      'Приглашаем вас на техническое интервью. Подскажите, пожалуйста, удобные дату и время.',
    )).toBe(true);
    expect(analyzeInterviewMessage(
      'Приглашаем вас на техническое интервью. Будем рады знакомству!',
    ).requestsCandidateAvailability).toBe(false);
  });
});

describe('availability and conflicts', () => {
  const monday = new Date(2026, 7, 10, 10, 0);

  it('accepts only slots fully inside a configured interval', () => {
    expect(isInterviewSlotAvailable(new Date(2026, 7, 10, 10, 0), settings(), [], 60, monday)).toBe(true);
    expect(isInterviewSlotAvailable(new Date(2026, 7, 10, 13, 30), settings(), [], 60, monday)).toBe(false);
    expect(isInterviewSlotAvailable(new Date(2026, 7, 10, 15, 0), settings(), [], 60, monday)).toBe(false);
  });

  it('rejects collisions with a proposed or confirmed interview', () => {
    const event: InterviewCalendarEvent = {
      id: 'existing',
      vacancyTitle: 'QA',
      companyName: 'Acme',
      type: 'hr',
      status: 'confirmed',
      startAt: new Date(2026, 7, 10, 11, 0).toISOString(),
      endAt: new Date(2026, 7, 10, 12, 0).toISOString(),
      source: 'manual',
      createdAt: monday.toISOString(),
      updatedAt: monday.toISOString(),
    };

    expect(isInterviewSlotAvailable(new Date(2026, 7, 10, 11, 30), settings(), [event], 60, monday)).toBe(false);
    expect(isInterviewSlotAvailable(new Date(2026, 7, 10, 12, 0), settings(), [event], 60, monday)).toBe(true);
  });

  it('offers the next non-conflicting windows instead of a rejected HR slot', () => {
    const event: InterviewCalendarEvent = {
      id: 'busy',
      vacancyTitle: 'Backend',
      companyName: 'Busy Co',
      type: 'technical',
      status: 'proposed',
      startAt: new Date(2026, 7, 10, 10, 0).toISOString(),
      endAt: new Date(2026, 7, 10, 11, 0).toISOString(),
      source: 'hh',
      createdAt: monday.toISOString(),
      updatedAt: monday.toISOString(),
    };

    const slots = findNextInterviewSlots(settings(), [event], new Date(2026, 7, 10, 9, 10), 3);
    expect(slots).toHaveLength(3);
    expect(slots[0].getHours()).toBe(11);
    expect(slots[1].getHours()).toBe(16);
    expect(slots[2].getDate()).toBe(17);
  });

  it('prefers concrete free alternatives today and tomorrow for a recruiter', () => {
    const now = new Date(2026, 7, 10, 9, 10);
    const recruiterSettings = settings({
      availability: [
        { id: 'mon', weekday: 1, startMinutes: 10 * 60, endMinutes: 14 * 60 },
        { id: 'tue', weekday: 2, startMinutes: 11 * 60, endMinutes: 14 * 60 },
      ],
    });

    const slots = findRecruiterInterviewSlots(recruiterSettings, [], now, 3);
    expect(slots).toHaveLength(3);
    expect(slots.map((slot) => [slot.getDate(), slot.getHours()])).toEqual([
      [10, 10],
      [10, 11],
      [11, 11],
    ]);
    expect(formatRecruiterInterviewSlotRu(slots[0], now)).toBe('сегодня в 10:00');
    expect(formatRecruiterInterviewSlotRu(slots[2], now)).toBe('завтра в 11:00');
  });

  it('adds the configured timezone to recruiter-facing slots', () => {
    const value = new Date('2026-08-10T04:00:00.000Z');
    const now = new Date('2026-08-09T04:00:00.000Z');
    expect(formatRecruiterInterviewSlotRu(value, now, 'Asia/Krasnoyarsk'))
      .toContain('UTC+7, Красноярск');
  });

  it('offers several times on the nearest later workday when the weekend is unavailable', () => {
    const saturday = new Date(2026, 7, 8, 18, 30);
    const weekdaySettings = settings({
      availability: [
        { id: 'mon', weekday: 1, startMinutes: 7 * 60, endMinutes: 14 * 60 },
      ],
      defaultDurationMin: 30,
      minimumNoticeMin: 24 * 60,
    });

    const slots = findRecruiterInterviewSlots(weekdaySettings, [], saturday, 3);
    expect(slots.map((slot) => [slot.getDate(), slot.getHours()])).toEqual([
      [10, 7],
      [10, 8],
      [10, 9],
    ]);
  });

  it('matches an ordinal confirmation to the alternatives previously sent by the bot', () => {
    const offered = [
      new Date(2026, 7, 10, 11, 0).toISOString(),
      new Date(2026, 7, 10, 16, 0).toISOString(),
    ];
    expect(chooseThreadSlot('Отлично, давайте второй вариант', offered)?.toISOString()).toBe(offered[1]);
  });
});

describe('InterviewCalendarStore', () => {
  it('persists availability and deduplicates an HH event by negotiation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-calendar-'));
    tempRoots.push(root);
    const store = new InterviewCalendarStore(root);
    store.saveSettings(settings());
    store.scheduleFromNegotiation({
      negotiationKey: 'QA\u0000Acme',
      vacancyTitle: 'QA',
      companyName: 'Acme',
      type: 'hr',
      start: new Date(2026, 7, 10, 11, 0),
      status: 'proposed',
    });
    store.scheduleFromNegotiation({
      negotiationKey: 'QA\u0000Acme',
      vacancyTitle: 'QA',
      companyName: 'Acme',
      type: 'hr',
      start: new Date(2026, 7, 10, 11, 0),
      status: 'confirmed',
    });

    const restored = new InterviewCalendarStore(root).getState();
    expect(restored.settings.availabilityConfigured).toBe(true);
    expect(restored.events).toHaveLength(1);
    expect(restored.events[0].status).toBe('confirmed');
  });

  it('deletes an event and keeps a linked session outcome on the same event', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-calendar-link-'));
    tempRoots.push(root);
    const store = new InterviewCalendarStore(root);
    const created = store.upsertEvent({
      vacancyTitle: 'QA Automation',
      companyName: 'Acme',
      type: 'hr',
      status: 'confirmed',
      startAt: new Date(2026, 7, 10, 11, 0).toISOString(),
      endAt: new Date(2026, 7, 10, 12, 0).toISOString(),
      source: 'manual',
    }).events[0];

    const sessionTime = new Date(2026, 7, 10, 10, 30);
    store.attachSession(created.id, 'session-one', sessionTime);
    store.saveOutcome(created.id, {
      sessionId: 'session-one',
      headline: 'Обсудили роль и следующий этап.',
      facts: ['Команда из пяти человек'],
      conditions: ['Удалённая работа'],
      nextSteps: ['Техническое интервью'],
      openQuestions: ['Вилка зарплаты'],
      createdAt: sessionTime.toISOString(),
    }, sessionTime);

    const restored = new InterviewCalendarStore(root);
    expect(restored.getEvent(created.id)?.sessionId).toBe('session-one');
    expect(restored.getEvent(created.id)?.outcome?.conditions).toEqual(['Удалённая работа']);
    expect(restored.removeEvent(created.id).events).toHaveLength(0);
  });

  it('links later stages to one vacancy journey without reusing the previous recording', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-calendar-journey-'));
    tempRoots.push(root);
    const store = new InterviewCalendarStore(root);
    const hr = store.upsertEvent({
      vacancyTitle: 'QA Automation',
      companyName: 'Acme',
      type: 'hr',
      status: 'completed',
      startAt: '2026-08-10T04:00:00.000Z',
      endAt: '2026-08-10T04:30:00.000Z',
      source: 'manual',
      vacancyUrl: 'https://hh.ru/vacancy/136064787',
      vacancyDescription: 'Python, Playwright, API testing',
      sessionId: 'hr-session',
    }).events[0];

    const technical = store.upsertEvent({
      vacancyTitle: 'QA Automation',
      companyName: 'Acme',
      type: 'technical',
      status: 'confirmed',
      startAt: '2026-08-12T04:00:00.000Z',
      endAt: '2026-08-12T05:00:00.000Z',
      source: 'manual',
      vacancyUrl: 'https://hh.ru/vacancy/136064787',
    }).events.find((event) => event.type === 'technical');

    expect(technical).toMatchObject({
      journeyId: hr.journeyId,
      vacancyDescription: 'Python, Playwright, API testing',
      vacancyUrl: 'https://hh.ru/vacancy/136064787',
    });
    expect(technical?.sessionId).toBeUndefined();
  });

  it('does not let an early practice session complete tomorrow\'s interview', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-calendar-practice-'));
    tempRoots.push(root);
    const store = new InterviewCalendarStore(root);
    const scheduled = store.upsertEvent({
      vacancyTitle: 'QA AUTO',
      companyName: 'MTC',
      type: 'technical',
      status: 'confirmed',
      startAt: '2026-08-10T04:00:00.000Z',
      endAt: '2026-08-10T05:00:00.000Z',
      source: 'manual',
    }).events[0];
    const practiceTime = new Date('2026-08-09T11:22:00.635Z');

    expect(canLinkSessionToInterview(scheduled, practiceTime)).toBe(false);
    store.attachSession(scheduled.id, 'practice-session', practiceTime);
    store.saveOutcome(scheduled.id, {
      sessionId: 'practice-session',
      headline: 'Проверка оверлея',
      facts: [],
      conditions: [],
      nextSteps: [],
      openQuestions: [],
      createdAt: practiceTime.toISOString(),
    }, practiceTime);

    expect(store.getEvent(scheduled.id)).toMatchObject({
      startAt: scheduled.startAt,
      status: 'confirmed',
    });
    expect(store.getEvent(scheduled.id)?.sessionId).toBeUndefined();
    expect(store.getEvent(scheduled.id)?.completedAt).toBeUndefined();
    expect(store.getEvent(scheduled.id)?.outcome).toBeUndefined();
  });

  it('repairs a prematurely completed future interview while loading persisted data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-calendar-repair-'));
    tempRoots.push(root);
    const store = new InterviewCalendarStore(root);
    const state = store.upsertEvent({
      vacancyTitle: 'QA AUTO',
      companyName: 'MTC',
      type: 'technical',
      status: 'confirmed',
      startAt: '2026-08-10T04:00:00.000Z',
      endAt: '2026-08-10T05:00:00.000Z',
      source: 'manual',
    });
    state.events[0] = {
      ...state.events[0],
      sessionId: 'practice-session',
      completedAt: '2026-08-09T11:22:00.635Z',
      outcome: {
        sessionId: 'practice-session',
        headline: 'Проверка оверлея',
        facts: [],
        conditions: [],
        nextSteps: [],
        openQuestions: [],
        createdAt: '2026-08-09T11:22:00.635Z',
      },
    };
    const persistedPath = path.join(root, 'interview-calendar.json');
    fs.writeFileSync(persistedPath, JSON.stringify(state, null, 2), 'utf8');

    const restored = new InterviewCalendarStore(root);
    expect(restored.getEvent(state.events[0].id)?.sessionId).toBeUndefined();
    expect(restored.getEvent(state.events[0].id)?.completedAt).toBeUndefined();
    expect(restored.getEvent(state.events[0].id)?.outcome).toBeUndefined();

    const repairedOnDisk = JSON.parse(fs.readFileSync(persistedPath, 'utf8')) as InterviewCalendarState;
    expect(repairedOnDisk.events[0].completedAt).toBeUndefined();
    expect(repairedOnDisk.events[0].outcome).toBeUndefined();
  });
});
