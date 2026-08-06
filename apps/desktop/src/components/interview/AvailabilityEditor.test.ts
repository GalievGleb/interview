import { describe, expect, it } from 'vitest';
import { formatAvailabilitySummary } from './AvailabilityEditor';

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

    expect(summary).toBe('Пн, Вт, Ср, Чт, Пт 10:00–18:00 · 60 мин · запас 1 дн');
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
});
