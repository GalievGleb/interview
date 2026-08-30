import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const calendarSource = fs.readFileSync(
  path.resolve(__dirname, '../pages/InterviewCalendarPage.tsx'),
  'utf8',
);
const calendarCss = fs.readFileSync(
  path.resolve(__dirname, 'interview-calendar.css'),
  'utf8',
);

describe('interview calendar event layout', () => {
  it('lets the page consume vertical wheel gestures over the fixed-height week grid', () => {
    const weekScrollRule = calendarCss.match(/\.interview-week-scroll\s*\{([^}]*)\}/s)?.[1] ?? '';

    expect(weekScrollRule).toContain('overflow-x: auto');
    expect(weekScrollRule).toContain('overflow-y: hidden');
    expect(weekScrollRule).toContain('overscroll-behavior-x: contain');
    expect(weekScrollRule).toContain('overscroll-behavior-y: auto');
    expect(weekScrollRule).not.toMatch(/(?:^|\n)\s*overscroll-behavior:\s*contain/);
  });

  it('keeps the vacancy visible in short event cards', () => {
    expect(calendarSource).toContain('interview-week-event__headline');
    expect(calendarSource).toContain("span === 1 ? 'is-compact' : ''");
    expect(calendarCss).toMatch(/\.interview-week-event__headline\s*\{[^}]*display:\s*flex/s);
    expect(calendarCss).toMatch(/\.interview-week-event\.is-compact \.interview-week-event__headline\s*\{[^}]*display:\s*none/s);
    expect(calendarCss).toMatch(/\.interview-week-event\.is-compact small\s*\{[^}]*margin-top:\s*0/s);
  });

  it('opens the useful week and preparation brief from the home next action', () => {
    expect(calendarSource).toContain('const initialWeekSelected = useRef(false)');
    expect(calendarSource).toContain('if (!visibleCurrentWeek)');
    expect(calendarSource).toContain('setWeekStart(startOfWeek(new Date(nearest.startAt)))');
    expect(calendarSource).toContain("searchParams.get('brief')");
    expect(calendarSource).toContain('openInterviewBriefRef.current(event)');
    expect(calendarSource).toContain("searchParams.get('edit')");
    expect(calendarSource).toContain('editEventRef.current(event)');
    expect(calendarSource).toContain('Данные для 100% готовности');
    expect(calendarSource).toContain('readinessEditMissing');
    expect(calendarSource).toContain('не хватает для 100%');
  });

  it('shows the nearest interview as a relative, themed banner', () => {
    expect(calendarSource).toContain('interview-next-banner');
    expect(calendarSource).toContain('formatHomeInterviewBadge(nextInterview.startAt');
    expect(calendarSource).toContain('Ближайшее собеседование');
    expect(calendarCss).toMatch(/\.interview-next-banner\s*\{[^}]*linear-gradient/s);
    expect(calendarCss).toMatch(/\.interview-next-banner\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(calendarCss).toContain(":root[data-theme='light'] .interview-next-banner");
  });

  it('keeps manual creation compact and reports save errors inside the dialog', () => {
    expect(calendarSource).toContain('size="lg"');
    expect(calendarSource).toContain('const [formError, setFormError]');
    expect(calendarSource).toContain('role="alert">{formError}</span>');
    expect(calendarSource).toContain('Добавить ссылку или требования');
    expect(calendarSource).toContain('· необязательно');
    expect(calendarSource).not.toContain('Данные для точной подготовки');
  });
});
