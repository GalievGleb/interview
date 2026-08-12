export interface CalendarSelectionRange {
  firstSlot: number;
  lastSlot: number;
  startMinutes: number;
  endMinutes: number;
  durationMin: number;
}

export interface CalendarGridBounds {
  startMinutes: number;
  endMinutes: number;
}

export interface CalendarGridPosition {
  dayIndex: number;
  slotIndex: number;
}

export type CalendarGridNavigationKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End';

/** Keeps keyboard focus inside the visible week using the APG grid pattern. */
export function moveCalendarGridFocus(
  current: CalendarGridPosition,
  key: CalendarGridNavigationKey,
  dayCount: number,
  slotCount: number,
): CalendarGridPosition {
  const maxDay = Math.max(0, dayCount - 1);
  const maxSlot = Math.max(0, slotCount - 1);
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

  switch (key) {
    case 'ArrowLeft':
      return { ...current, dayIndex: clamp(current.dayIndex - 1, maxDay) };
    case 'ArrowRight':
      return { ...current, dayIndex: clamp(current.dayIndex + 1, maxDay) };
    case 'ArrowUp':
      return { ...current, slotIndex: clamp(current.slotIndex - 1, maxSlot) };
    case 'ArrowDown':
      return { ...current, slotIndex: clamp(current.slotIndex + 1, maxSlot) };
    case 'Home':
      return { ...current, dayIndex: 0 };
    case 'End':
      return { ...current, dayIndex: maxDay };
  }
}

export function calendarGridBounds(
  availability: Array<{ startMinutes: number; endMinutes: number }>,
  events: Array<{ startMinutes: number; endMinutes: number }>,
  slotMinutes = 30,
): CalendarGridBounds {
  const starts = [8 * 60, ...availability.map((item) => item.startMinutes), ...events.map((item) => item.startMinutes)];
  const ends = [18 * 60, ...availability.map((item) => item.endMinutes), ...events.map((item) => item.endMinutes)];
  const startMinutes = Math.max(0, Math.floor(Math.min(...starts) / slotMinutes) * slotMinutes);
  const roundedEnd = Math.min(24 * 60, Math.ceil(Math.max(...ends) / slotMinutes) * slotMinutes);
  return {
    startMinutes,
    endMinutes: Math.max(startMinutes + 4 * 60, roundedEnd),
  };
}

export function calendarSelectionRange(
  startSlot: number,
  currentSlot: number,
  calendarStartMinutes = 8 * 60,
  slotMinutes = 30,
): CalendarSelectionRange {
  const firstSlot = Math.min(startSlot, currentSlot);
  const lastSlot = Math.max(startSlot, currentSlot);
  const startMinutes = calendarStartMinutes + firstSlot * slotMinutes;
  const endMinutes = calendarStartMinutes + (lastSlot + 1) * slotMinutes;
  return {
    firstSlot,
    lastSlot,
    startMinutes,
    endMinutes,
    durationMin: endMinutes - startMinutes,
  };
}
