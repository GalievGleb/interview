import { describe, expect, it } from 'vitest';
import {
  copyAvailabilityDay,
  formatAvailabilitySummary,
  formatTimezoneDisplay,
} from './AvailabilityEditor';

describe('interview availability summary', () => {
  it('groups days with the same time range into a compact response-tab summary', () => {
    const summary = formatAvailabilitySummary({
      availabilityConfigured: true,
      availability: [1, 2, 3, 4, 5].map((weekday) => ({
        id: `weekday-${weekday}`,
        weekday,
        startMinutes: 10 * 60,
        endMinutes: 18 * 60,
      })),
      defaultDurationMin: 60,
      minimumNoticeMin: 24 * 60,
      timezone: 'Asia/Krasnoyarsk',
    });

    expect(summary).toBe('Пн, Вт, Ср, Чт, Пт 10:00–18:00 · не раньше чем через 1 день');
  });

  it('clearly reports that availability still needs to be configured', () => {
    expect(formatAvailabilitySummary({
      availabilityConfigured: false,
      availability: [],
      defaultDurationMin: 60,
      minimumNoticeMin: 1440,
      timezone: 'Asia/Krasnoyarsk',
    })).toBe('Время ещё не настроено');
  });

  it('shows a human-readable UTC offset next to the city', () => {
    expect(formatTimezoneDisplay('Asia/Krasnoyarsk', new Date('2026-08-07T00:00:00Z')))
      .toBe('UTC+7 · Красноярск');
  });

  it('copies all intervals from one day to the selected days', () => {
    const copied = copyAvailabilityDay([
      { id: 'mon-morning', weekday: 1, startMinutes: 10 * 60, endMinutes: 13 * 60 },
      { id: 'mon-evening', weekday: 1, startMinutes: 18 * 60, endMinutes: 20 * 60 },
      { id: 'tue-old', weekday: 2, startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { id: 'sat', weekday: 6, startMinutes: 12 * 60, endMinutes: 14 * 60 },
    ], 1, [1, 2, 3, 4, 5]);

    expect(copied.filter((window) => window.weekday === 2).map((window) => [window.startMinutes, window.endMinutes]))
      .toEqual([[10 * 60, 13 * 60], [18 * 60, 20 * 60]]);
    expect(copied.filter((window) => window.weekday === 5)).toHaveLength(2);
    expect(copied.find((window) => window.weekday === 6)?.id).toBe('sat');
  });
});
