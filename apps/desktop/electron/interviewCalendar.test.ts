import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InterviewCalendarStore,
  analyzeInterviewMessage,
  chooseThreadSlot,
  findNextInterviewSlots,
  isInterviewSlotAvailable,
  parseInterviewSlots,
  type InterviewCalendarEvent,
  type InterviewCalendarSettings,
} from './interviewCalendar';

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
});
