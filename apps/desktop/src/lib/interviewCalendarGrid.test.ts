import { describe, expect, it } from 'vitest';
import {
  calendarGridBounds,
  calendarSelectionRange,
  moveCalendarGridFocus,
} from './interviewCalendarGrid';

describe('calendar drag selection', () => {
  it('expands the grid to configured availability and late events', () => {
    expect(calendarGridBounds(
      [{ startMinutes: 7 * 60, endMinutes: 14 * 60 }],
      [{ startMinutes: 19 * 60 + 15, endMinutes: 20 * 60 + 10 }],
    )).toEqual({ startMinutes: 7 * 60, endMinutes: 20 * 60 + 30 });
  });
  it('turns several half-hour cells into one exact time range', () => {
    expect(calendarSelectionRange(4, 6)).toEqual({
      firstSlot: 4,
      lastSlot: 6,
      startMinutes: 10 * 60,
      endMinutes: 11 * 60 + 30,
      durationMin: 90,
    });
  });

  it('keeps the same range when the user drags upwards', () => {
    expect(calendarSelectionRange(6, 4)).toEqual(calendarSelectionRange(4, 6));
  });

  it('uses one cell as a 30-minute event', () => {
    expect(calendarSelectionRange(7, 7)).toMatchObject({
      startMinutes: 11 * 60 + 30,
      endMinutes: 12 * 60,
      durationMin: 30,
    });
  });
});

describe('calendar keyboard grid', () => {
  it('moves between days and slots without leaving the grid', () => {
    expect(moveCalendarGridFocus({ dayIndex: 2, slotIndex: 3 }, 'ArrowRight', 7, 20))
      .toEqual({ dayIndex: 3, slotIndex: 3 });
    expect(moveCalendarGridFocus({ dayIndex: 2, slotIndex: 3 }, 'ArrowDown', 7, 20))
      .toEqual({ dayIndex: 2, slotIndex: 4 });
    expect(moveCalendarGridFocus({ dayIndex: 0, slotIndex: 0 }, 'ArrowLeft', 7, 20))
      .toEqual({ dayIndex: 0, slotIndex: 0 });
    expect(moveCalendarGridFocus({ dayIndex: 6, slotIndex: 19 }, 'ArrowDown', 7, 20))
      .toEqual({ dayIndex: 6, slotIndex: 19 });
  });

  it('jumps to the beginning or end of the current row', () => {
    expect(moveCalendarGridFocus({ dayIndex: 3, slotIndex: 4 }, 'Home', 7, 20).dayIndex).toBe(0);
    expect(moveCalendarGridFocus({ dayIndex: 3, slotIndex: 4 }, 'End', 7, 20).dayIndex).toBe(6);
  });
});
