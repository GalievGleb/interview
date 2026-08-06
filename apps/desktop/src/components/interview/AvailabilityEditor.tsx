import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
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

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function minutesToTime(value: number): string {
  return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function windowId(weekday: number): string {
  return `window-${weekday}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newWindow(weekday: number, existing: AvailabilityWindow[]): AvailabilityWindow {
  const last = [...existing].sort((left, right) => left.endMinutes - right.endMinutes).at(-1);
  const startMinutes = last ? Math.min(last.endMinutes + 60, 21 * 60) : 10 * 60;
  return {
    id: windowId(weekday),
    weekday,
    startMinutes,
    endMinutes: Math.min(startMinutes + 2 * 60, 23 * 60),
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

function noticeLabel(minutes: number): string {
  if (minutes === 0) return 'без запаса';
  if (minutes < 60) return `запас ${minutes} мин`;
  if (minutes < 24 * 60) return `запас ${minutes / 60} ч`;
  return `запас ${minutes / (24 * 60)} дн`;
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
  return `${schedule} · ${settings.defaultDurationMin} мин · ${noticeLabel(settings.minimumNoticeMin)}`;
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
  const [durationMin, setDurationMin] = useState(settings.defaultDurationMin);
  const [noticeMin, setNoticeMin] = useState(settings.minimumNoticeMin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setAvailability(cloneWindows(settings.availability));
    setDurationMin(settings.defaultDurationMin);
    setNoticeMin(settings.minimumNoticeMin);
  }, [settings]);

  const invalidWindow = useMemo(
    () => availability.some((window) => window.endMinutes <= window.startMinutes),
    [availability],
  );

  const applyPreset = (preset: 'workday' | 'evening' | 'weekend') => {
    setError('');
    if (preset === 'workday') setAvailability(presetWindows([1, 2, 3, 4, 5], 10 * 60, 18 * 60));
    if (preset === 'evening') setAvailability(presetWindows([1, 2, 3, 4, 5], 18 * 60, 21 * 60));
    if (preset === 'weekend') setAvailability(presetWindows([6, 0], 10 * 60, 18 * 60));
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
        defaultDurationMin: durationMin,
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
    <div className="space-y-3">
      <div>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Быстрый выбор</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost btn-sm" onClick={() => applyPreset('workday')}>Будни 10–18</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => applyPreset('evening')}>Будни после 18</button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => applyPreset('weekend')}>Только выходные</button>
        </div>
      </div>

      <div className={compact ? 'grid gap-2 md:grid-cols-2' : 'space-y-3'}>
        {AVAILABILITY_DAYS.map((day) => {
          const windows = availability
            .filter((window) => window.weekday === day.weekday)
            .sort((left, right) => left.startMinutes - right.startMinutes);
          return (
            <div key={day.weekday} className="rounded-xl border border-surface-border bg-surface/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-ink">{compact ? day.short : day.label}</span>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300"
                  onClick={() => setAvailability((current) => [...current, newWindow(day.weekday, windows)])}
                >
                  <Plus size={12} /> Интервал
                </button>
              </div>
              {windows.length === 0 ? (
                <p className="mt-2 text-[11px] text-ink-faint">Не предлагать</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {windows.map((window) => (
                    <div key={window.id} className="flex items-center gap-1.5">
                      <input
                        type="time"
                        className="field min-w-0 px-2 py-1.5 text-xs"
                        value={minutesToTime(window.startMinutes)}
                        onChange={(event) => setAvailability((current) => current.map((item) => (
                          item.id === window.id ? { ...item, startMinutes: timeToMinutes(event.target.value) } : item
                        )))}
                      />
                      <span className="text-xs text-ink-faint">—</span>
                      <input
                        type="time"
                        className="field min-w-0 px-2 py-1.5 text-xs"
                        value={minutesToTime(window.endMinutes)}
                        onChange={(event) => setAvailability((current) => current.map((item) => (
                          item.id === window.id ? { ...item, endMinutes: timeToMinutes(event.target.value) } : item
                        )))}
                      />
                      <button
                        type="button"
                        className="shrink-0 p-1 text-ink-faint hover:text-red-300"
                        aria-label={`Удалить интервал: ${day.label}`}
                        onClick={() => setAvailability((current) => current.filter((item) => item.id !== window.id))}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="label">Длительность созвона</span>
          <select className="field py-2 text-xs" value={durationMin} onChange={(event) => setDurationMin(Number(event.target.value))}>
            <option value={30}>30 минут</option><option value={45}>45 минут</option><option value={60}>1 час</option><option value={90}>1,5 часа</option><option value={120}>2 часа</option>
          </select>
        </label>
        <label>
          <span className="label">Не назначать раньше чем</span>
          <select className="field py-2 text-xs" value={noticeMin} onChange={(event) => setNoticeMin(Number(event.target.value))}>
            <option value={0}>Без запаса</option><option value={120}>За 2 часа</option><option value={720}>За 12 часов</option><option value={1440}>За 1 день</option><option value={2880}>За 2 дня</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          {settings.availabilityConfigured && <CheckCircle2 className="text-emerald-300" size={14} />}
          Часовой пояс: {settings.timezone}
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
