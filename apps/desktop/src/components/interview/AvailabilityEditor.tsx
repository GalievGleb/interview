import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleHelp, Copy, Plus, Trash2 } from 'lucide-react';
import type { AvailabilityWindow, InterviewCalendarSettings } from '../../types/electron';

export const AVAILABILITY_DAYS = [
  { weekday: 1, short: 'Пн', label: 'Понедельник' },
  { weekday: 2, short: 'Вт', label: 'Вторник' },
  { weekday: 3, short: 'Ср', label: 'Среда' },
  { weekday: 4, short: 'Чт', label: 'Четверг' },
  { weekday: 5, short: 'Пт', label: 'Пятница' },
  { weekday: 6, short: 'Сб', label: 'Суббота' },
  { weekday: 0, short: 'Вс', label: 'Воскресенье' },
] as const;

const WEEKDAYS = [1, 2, 3, 4, 5] as const;
const ALL_DAYS = AVAILABILITY_DAYS.map((day) => day.weekday);
const TIME_STEP_MINUTES = 15;
const TIME_OPTIONS = Array.from(
  { length: (24 * 60) / TIME_STEP_MINUTES + 1 },
  (_, index) => index * TIME_STEP_MINUTES,
);

const TIMEZONE_CITY_LABELS: Record<string, string> = {
  'Asia/Barnaul': 'Барнаул',
  'Asia/Irkutsk': 'Иркутск',
  'Asia/Kamchatka': 'Камчатка',
  'Asia/Krasnoyarsk': 'Красноярск',
  'Asia/Magadan': 'Магадан',
  'Asia/Novosibirsk': 'Новосибирск',
  'Asia/Omsk': 'Омск',
  'Asia/Sakhalin': 'Сахалин',
  'Asia/Tomsk': 'Томск',
  'Asia/Vladivostok': 'Владивосток',
  'Asia/Yakutsk': 'Якутск',
  'Asia/Yekaterinburg': 'Екатеринбург',
  'Europe/Kaliningrad': 'Калининград',
  'Europe/Moscow': 'Москва',
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function minutesToTime(value: number): string {
  if (value === 24 * 60) return '24:00';
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} ч ${remainder} мин` : `${hours} ч`;
}

function windowId(weekday: number): string {
  return `window-${weekday}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newWindow(weekday: number, existing: AvailabilityWindow[]): AvailabilityWindow {
  const last = [...existing].sort((left, right) => left.endMinutes - right.endMinutes).at(-1);
  const proposedStart = last ? last.endMinutes + 30 : 10 * 60;
  const startMinutes = proposedStart >= 23 * 60 ? 10 * 60 : proposedStart;
  return {
    id: windowId(weekday),
    weekday,
    startMinutes,
    endMinutes: Math.min(startMinutes + 2 * 60, 24 * 60),
  };
}

function presetWindows(days: readonly number[], startMinutes: number, endMinutes: number): AvailabilityWindow[] {
  return days.map((weekday) => ({
    id: windowId(weekday),
    weekday,
    startMinutes,
    endMinutes,
  }));
}

function cloneWindows(windows: AvailabilityWindow[]): AvailabilityWindow[] {
  return windows.map((window) => ({ ...window }));
}

export function copyAvailabilityDay(
  windows: AvailabilityWindow[],
  sourceWeekday: number,
  targetWeekdays: readonly number[],
): AvailabilityWindow[] {
  const source = windows
    .filter((window) => window.weekday === sourceWeekday)
    .sort((left, right) => left.startMinutes - right.startMinutes);
  if (source.length === 0) return windows;
  const targets = new Set(targetWeekdays);
  return [
    ...windows.filter((window) => !targets.has(window.weekday)),
    ...targetWeekdays.flatMap((weekday) => source.map((window) => ({
      ...window,
      id: windowId(weekday),
      weekday,
    }))),
  ];
}

function timezoneOffset(timezone: string, at: Date): string {
  try {
    const offset = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
    if (!match) return 'UTC+0';
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    return `UTC${match[1]}${hours}${minutes ? `:${pad(minutes)}` : ''}`;
  } catch {
    return 'Локальное время';
  }
}

export function formatTimezoneDisplay(timezone: string, at = new Date()): string {
  const fallbackCity = timezone.split('/').at(-1)?.replaceAll('_', ' ') || timezone;
  const city = TIMEZONE_CITY_LABELS[timezone] ?? fallbackCity;
  return `${timezoneOffset(timezone, at)} · ${city}`;
}

function noticeLabel(minutes: number): string {
  if (minutes === 0) return 'можно назначать сразу';
  if (minutes < 60) return `не раньше чем через ${minutes} мин`;
  if (minutes < 24 * 60) return `не раньше чем через ${durationLabel(minutes)}`;
  const days = minutes / (24 * 60);
  return `не раньше чем через ${days} ${days === 1 ? 'день' : 'дня'}`;
}

export function formatAvailabilitySummary(settings: InterviewCalendarSettings): string {
  if (!settings.availabilityConfigured || settings.availability.length === 0) {
    return 'Время ещё не настроено';
  }
  const groups = new Map<string, string[]>();
  for (const day of AVAILABILITY_DAYS) {
    const windows = settings.availability
      .filter((window) => window.weekday === day.weekday)
      .sort((left, right) => left.startMinutes - right.startMinutes);
    if (windows.length === 0) continue;
    const ranges = windows
      .map((window) => `${minutesToTime(window.startMinutes)}–${minutesToTime(window.endMinutes)}`)
      .join(', ');
    groups.set(ranges, [...(groups.get(ranges) ?? []), day.short]);
  }
  const schedule = [...groups.entries()]
    .map(([ranges, days]) => `${days.join(', ')} ${ranges}`)
    .join(' · ');
  return `${schedule} · ${noticeLabel(settings.minimumNoticeMin)}`;
}

interface AvailabilityEditorProps {
  settings: InterviewCalendarSettings;
  onSave: (settings: Partial<InterviewCalendarSettings>) => Promise<unknown>;
  compact?: boolean;
  submitLabel?: string;
  allowClear?: boolean;
}

export default function AvailabilityEditor({
  settings,
  onSave,
  compact = false,
  submitLabel = 'Сохранить доступность',
  allowClear = false,
}: AvailabilityEditorProps) {
  const [availability, setAvailability] = useState<AvailabilityWindow[]>(() => cloneWindows(settings.availability));
  const [noticeMin, setNoticeMin] = useState(settings.minimumNoticeMin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    setAvailability(cloneWindows(settings.availability));
    setNoticeMin(settings.minimumNoticeMin);
  }, [settings]);

  const invalidWindow = useMemo(
    () => availability.some((window) => window.endMinutes <= window.startMinutes),
    [availability],
  );

  const applyPreset = (preset: 'workday' | 'evening' | 'weekend') => {
    setError('');
    setCopyMessage('');
    if (preset === 'workday') setAvailability(presetWindows(WEEKDAYS, 10 * 60, 18 * 60));
    if (preset === 'evening') setAvailability(presetWindows(WEEKDAYS, 18 * 60, 21 * 60));
    if (preset === 'weekend') setAvailability(presetWindows([6, 0], 10 * 60, 18 * 60));
  };

  const toggleDay = (weekday: number) => {
    setError('');
    setCopyMessage('');
    setAvailability((current) => {
      const active = current.some((window) => window.weekday === weekday);
      if (active) return current.filter((window) => window.weekday !== weekday);
      const templateDay = AVAILABILITY_DAYS.find((day) => current.some((window) => window.weekday === day.weekday));
      const template = templateDay
        ? current.filter((window) => window.weekday === templateDay.weekday)
        : [{ id: '', weekday, startMinutes: 10 * 60, endMinutes: 18 * 60 }];
      return [...current, ...template.map((window) => ({ ...window, id: windowId(weekday), weekday }))];
    });
  };

  const updateStart = (id: string, startMinutes: number) => {
    setAvailability((current) => current.map((item) => {
      if (item.id !== id) return item;
      const previousLength = Math.max(TIME_STEP_MINUTES, item.endMinutes - item.startMinutes);
      return {
        ...item,
        startMinutes,
        endMinutes: Math.min(24 * 60, startMinutes + previousLength),
      };
    }));
  };

  const copyDay = (weekday: number, targets: readonly number[], label: string) => {
    setAvailability((current) => copyAvailabilityDay(current, weekday, targets));
    setCopyMessage(`Расписание скопировано: ${label}.`);
    setError('');
  };

  const save = async () => {
    if (availability.length === 0 && !allowClear) {
      setError('Добавьте хотя бы один день и интервал.');
      return;
    }
    if (invalidWindow) {
      setError('Конец интервала должен быть позже начала.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({
        availability,
        availabilityConfigured: availability.length > 0,
        minimumNoticeMin: noticeMin,
        timezone: settings.timezone,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось сохранить доступность.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Быстрый выбор</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost btn-sm" onClick={() => applyPreset('workday')}>Будни 10–18</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => applyPreset('evening')}>Будни после 18</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => applyPreset('weekend')}>Только выходные</button>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-ink">Дни и свободные часы</p>
            <p className="mt-0.5 text-[11px] text-ink-faint">Включите день и выберите начало и конец. Шаг — 15 минут.</p>
          </div>
        </div>
        <div className={compact ? 'grid gap-2 lg:grid-cols-2' : 'space-y-2'}>
          {AVAILABILITY_DAYS.map((day) => {
            const windows = availability
              .filter((window) => window.weekday === day.weekday)
              .sort((left, right) => left.startMinutes - right.startMinutes);
            const active = windows.length > 0;
            return (
              <div key={day.weekday} className={`rounded-xl border p-3 transition-colors ${active ? 'border-emerald-500/20 bg-emerald-500/[0.035]' : 'border-surface-border bg-surface/20'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-emerald-400"
                      checked={active}
                      onChange={() => toggleDay(day.weekday)}
                    />
                    <span className="text-xs font-semibold text-ink">{compact ? day.short : day.label}</span>
                    {!active && <span className="text-[11px] text-ink-faint">не предлагать</span>}
                  </label>
                  {active && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-400/10"
                      onClick={() => setAvailability((current) => [...current, newWindow(day.weekday, windows)])}
                    >
                      <Plus size={12} /> Ещё интервал
                    </button>
                  )}
                </div>

                {active && (
                  <>
                    <div className="mt-3 space-y-2">
                      {windows.map((window) => (
                        <div key={window.id} className="flex items-end gap-2">
                          <label className="min-w-0 flex-1">
                            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-faint">С</span>
                            <select
                              className="field h-9 min-w-0 py-1.5 text-xs tabular-nums"
                              aria-label={`Начало: ${day.label}`}
                              value={window.startMinutes}
                              onChange={(event) => updateStart(window.id, Number(event.target.value))}
                            >
                              {TIME_OPTIONS.slice(0, -1).map((minutes) => <option key={minutes} value={minutes}>{minutesToTime(minutes)}</option>)}
                            </select>
                          </label>
                          <span className="pb-2 text-xs text-ink-faint">—</span>
                          <label className="min-w-0 flex-1">
                            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-faint">До</span>
                            <select
                              className="field h-9 min-w-0 py-1.5 text-xs tabular-nums"
                              aria-label={`Конец: ${day.label}`}
                              value={window.endMinutes}
                              onChange={(event) => setAvailability((current) => current.map((item) => (
                                item.id === window.id ? { ...item, endMinutes: Number(event.target.value) } : item
                              )))}
                            >
                              {TIME_OPTIONS.filter((minutes) => minutes > window.startMinutes).map((minutes) => <option key={minutes} value={minutes}>{minutesToTime(minutes)}</option>)}
                            </select>
                          </label>
                          <button
                            type="button"
                            className="mb-0.5 shrink-0 rounded-lg p-2 text-ink-faint hover:bg-red-400/10 hover:text-red-300"
                            aria-label={`Удалить интервал: ${day.label}`}
                            onClick={() => setAvailability((current) => current.filter((item) => item.id !== window.id))}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-surface-border/70 pt-2.5">
                      <span className="mr-0.5 text-[10px] text-ink-faint">Повторить этот день:</span>
                      <button type="button" className="inline-flex items-center gap-1 rounded-md bg-surface-light px-2 py-1 text-[10px] font-medium text-ink-muted hover:text-ink" onClick={() => copyDay(day.weekday, WEEKDAYS, 'Пн–Пт')}>
                        <Copy size={10} /> Пн–Пт
                      </button>
                      <button type="button" className="inline-flex items-center gap-1 rounded-md bg-surface-light px-2 py-1 text-[10px] font-medium text-ink-muted hover:text-ink" onClick={() => copyDay(day.weekday, ALL_DAYS, 'вся неделя')}>
                        <Copy size={10} /> Вся неделя
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {copyMessage && <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-300"><CheckCircle2 size={13} />{copyMessage}</p>}
      </div>

      <label className="block rounded-xl border border-surface-border bg-surface/30 p-3.5">
        <span className="flex items-center gap-2 text-xs font-semibold text-ink"><CircleHelp size={15} className="text-violet-300" />За сколько времени можно назначать созвон?</span>
        <span className="mt-1 block text-[11px] leading-relaxed text-ink-muted">Например, «за 1 день» означает, что бот не предложит сегодня встречу на ближайшие 24 часа.</span>
        <select className="field mt-2.5 py-2 text-xs" value={noticeMin} onChange={(event) => setNoticeMin(Number(event.target.value))}>
          <option value={0}>Можно сразу</option><option value={120}>Минимум за 2 часа</option><option value={720}>Минимум за 12 часов</option><option value={1440}>Минимум за 1 день</option><option value={2880}>Минимум за 2 дня</option>
        </select>
      </label>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="flex items-center gap-1.5 text-[11px] text-ink-faint" title={settings.timezone}>
          {settings.availabilityConfigured && <CheckCircle2 className="text-emerald-300" size={14} />}
          Часовой пояс: <strong className="font-semibold text-ink-muted">{formatTimezoneDisplay(settings.timezone)}</strong>
        </p>
        <div className="flex flex-wrap gap-2">
          {allowClear && settings.availabilityConfigured && (
            <button type="button" className="btn-ghost text-red-300" disabled={saving} onClick={() => setAvailability([])}>
              Очистить
            </button>
          )}
          <button type="button" className="btn-primary" disabled={saving || invalidWindow} onClick={() => void save()}>
            {saving ? 'Сохраняю…' : submitLabel}
          </button>
        </div>
      </div>
      {error && <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5 text-xs text-amber-200">{error}</p>}
    </div>
  );
}
