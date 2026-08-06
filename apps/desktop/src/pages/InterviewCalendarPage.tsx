import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Clock3,
  ExternalLink,
  MessageCircle,
  Pencil,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import AvailabilityEditor, { AVAILABILITY_DAYS } from '../components/interview/AvailabilityEditor';
import Modal from '../components/Modal';
import type {
  InterviewCalendarEvent,
  InterviewCalendarSettings,
  InterviewCalendarState,
  InterviewEventDraft,
  InterviewSchedulingThread,
  InterviewType,
} from '../types/electron';

const DAYS = AVAILABILITY_DAYS;

const EMPTY_SETTINGS: InterviewCalendarSettings = {
  availabilityConfigured: false,
  availability: [],
  defaultDurationMin: 60,
  minimumNoticeMin: 1440,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Локальное время',
};

const EMPTY_STATE: InterviewCalendarState = {
  settings: EMPTY_SETTINGS,
  events: [],
  scheduling: [],
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toDateInput(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function defaultStart(): string {
  const value = new Date();
  value.setDate(value.getDate() + 1);
  value.setHours(10, 0, 0, 0);
  return toDateInput(value);
}

function startOfWeek(value: Date): Date {
  const result = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const day = result.getDay() || 7;
  result.setDate(result.getDate() - day + 1);
  return result;
}

function addDays(value: Date, amount: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + amount);
  return result;
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatFull(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function typeMeta(type: InterviewType): { label: string; tone: string } {
  if (type === 'hr') return { label: 'HR', tone: 'border-violet-400/30 bg-violet-400/10 text-violet-300' };
  if (type === 'technical') return { label: 'Техническое', tone: 'border-sky-400/30 bg-sky-400/10 text-sky-300' };
  return { label: 'Собеседование', tone: 'border-amber-400/30 bg-amber-400/10 text-amber-300' };
}

function threadMeta(thread: InterviewSchedulingThread): { label: string; tone: string } {
  if (thread.stage === 'needs_availability' || thread.stage === 'needs_attention') {
    return { label: 'Требует внимания', tone: 'text-amber-300' };
  }
  if (thread.stage === 'awaiting_confirmation') {
    return { label: 'Ждём подтверждения', tone: 'text-sky-300' };
  }
  return { label: 'Ждём ответа HR', tone: 'text-violet-300' };
}

interface EventForm {
  id?: string;
  negotiationKey?: string;
  source: 'hh' | 'manual';
  vacancyTitle: string;
  companyName: string;
  type: InterviewType;
  status: 'proposed' | 'confirmed';
  startAt: string;
  durationMin: number;
  meetingUrl: string;
  notes: string;
}

function emptyEventForm(): EventForm {
  return {
    source: 'manual',
    vacancyTitle: '',
    companyName: '',
    type: 'hr',
    status: 'confirmed',
    startAt: defaultStart(),
    durationMin: 60,
    meetingUrl: '',
    notes: '',
  };
}

export default function InterviewCalendarPage() {
  const calendar = window.electronAPI?.interviewCalendar;
  const navigate = useNavigate();
  const [state, setState] = useState<InterviewCalendarState>(EMPTY_STATE);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [form, setForm] = useState<EventForm | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!calendar) return;
    let active = true;
    const apply = (next: InterviewCalendarState) => {
      if (!active) return;
      setState(next);
    };
    void calendar.getState().then(apply).catch((reason) => setError(String(reason)));
    const unsubscribe = calendar.onState(apply);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [calendar]);

  const weekDays = useMemo(() => DAYS.map((_, index) => addDays(weekStart, index)), [weekStart]);
  const activeEvents = useMemo(
    () => state.events.filter((event) => event.status !== 'cancelled'),
    [state.events],
  );
  const upcoming = useMemo(
    () => activeEvents
      .filter((event) => new Date(event.endAt).getTime() >= Date.now())
      .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt)),
    [activeEvents],
  );
  const activeThreads = useMemo(
    () => state.scheduling
      .filter((thread) => !thread.hidden && !['confirmed', 'cancelled'].includes(thread.stage))
      .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt)),
    [state.scheduling],
  );
  const nextInterview = upcoming[0];

  const saveAvailability = async (settings: Partial<InterviewCalendarSettings>) => {
    if (!calendar) return;
    setBusy('settings');
    setError('');
    try {
      const next = await calendar.saveSettings(settings);
      setState(next);
      setMessage(settings.availability?.length
        ? 'Доступность сохранена. Бот будет сверять с ней предложения HR.'
        : 'Доступность очищена. Бот приостановит согласование времени.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  const submitEvent = async () => {
    if (!calendar || !form) return;
    if (!form.vacancyTitle.trim() || !form.companyName.trim() || !form.startAt) {
      setError('Укажите вакансию, компанию и время.');
      return;
    }
    const start = new Date(form.startAt);
    if (Number.isNaN(start.getTime())) {
      setError('Не удалось распознать дату встречи.');
      return;
    }
    setBusy('event');
    setError('');
    const draft: InterviewEventDraft = {
      id: form.id,
      negotiationKey: form.negotiationKey,
      vacancyTitle: form.vacancyTitle.trim(),
      companyName: form.companyName.trim(),
      type: form.type,
      status: form.status,
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + form.durationMin * 60_000).toISOString(),
      source: form.source,
      meetingUrl: form.meetingUrl.trim() || undefined,
      notes: form.notes.trim() || undefined,
    };
    try {
      setState(await calendar.upsertEvent(draft));
      setForm(null);
      setMessage(form.id ? 'Собеседование обновлено.' : 'Собеседование добавлено.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  const editEvent = (event: InterviewCalendarEvent) => {
    setForm({
      id: event.id,
      negotiationKey: event.negotiationKey,
      source: event.source,
      vacancyTitle: event.vacancyTitle,
      companyName: event.companyName,
      type: event.type,
      status: event.status === 'cancelled' ? 'proposed' : event.status,
      startAt: toDateInput(new Date(event.startAt)),
      durationMin: Math.max(15, Math.round((+new Date(event.endAt) - +new Date(event.startAt)) / 60_000)),
      meetingUrl: event.meetingUrl ?? '',
      notes: event.notes ?? '',
    });
  };

  const removeEvent = async (event: InterviewCalendarEvent) => {
    if (!calendar || !window.confirm(`Удалить собеседование «${event.vacancyTitle}»?`)) return;
    setState(await calendar.removeEvent(event.id));
    setMessage('Собеседование удалено.');
  };

  const openMeeting = (event: InterviewCalendarEvent) => {
    if (event.meetingUrl) void window.electronAPI?.openExternal(event.meetingUrl);
  };

  if (!calendar) {
    return <div className="panel-card p-6 text-sm text-ink-muted">Календарь доступен в приложении SkillCue для компьютера.</div>;
  }

  return (
    <div className="flex min-h-full flex-col gap-5 pb-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">
            <CalendarDays size={15} /> Собеседования
          </div>
          <h1 className="page-title">Календарь созвонов</h1>
          <p className="page-subtitle mt-1">Все этапы, компании и договорённости с HR — в одном месте.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setForm(emptyEventForm())}>
          <CirclePlus size={16} /> Добавить вручную
        </button>
      </header>

      {(message || error) && (
        <div className={`flex items-center justify-between rounded-xl border px-4 py-3 text-sm ${error ? 'border-red-500/25 bg-red-500/5 text-red-300' : 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300'}`} role="status">
          <span>{error || message}</span>
          <button type="button" onClick={() => { setMessage(''); setError(''); }} aria-label="Закрыть"><X size={15} /></button>
        </div>
      )}

      {!state.settings.availabilityConfigured && (
        <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4">
          <div className="grid h-10 w-10 place-items-center rounded-full bg-amber-400/10 text-amber-300"><AlertTriangle size={19} /></div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">Сначала укажите удобное время</p>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">Пока доступность не заполнена, бот не будет придумывать даты и отвечать HR от вашего имени.</p>
          </div>
          <button type="button" className="btn-secondary" onClick={() => document.getElementById('availability-settings')?.scrollIntoView({ behavior: 'smooth' })}>
            <Settings2 size={15} /> Настроить
          </button>
        </section>
      )}

      {nextInterview && (
        <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.07] p-4 shadow-soft">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-400/12 text-emerald-300"><Clock3 size={20} /></div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">Ближайшее собеседование</p>
            <p className="mt-0.5 truncate text-base font-semibold text-ink">{nextInterview.companyName} · {nextInterview.vacancyTitle}</p>
            <p className="mt-0.5 text-sm text-ink-muted">{formatFull(nextInterview.startAt)}</p>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-xs ${typeMeta(nextInterview.type).tone}`}>{typeMeta(nextInterview.type).label}</span>
          {nextInterview.meetingUrl && <button type="button" className="btn-primary" onClick={() => openMeeting(nextInterview)}><ExternalLink size={15} /> Открыть ссылку</button>}
        </section>
      )}

      {activeThreads.length > 0 && (
        <section className="panel-card overflow-hidden">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Согласование с HR</h2>
              <p className="mt-0.5 text-xs text-ink-faint">Что сейчас происходит в переписках</p>
            </div>
            <button type="button" className="btn-ghost btn-sm" onClick={() => navigate('/applications')}><MessageCircle size={14} /> К откликам</button>
          </div>
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {activeThreads.map((thread) => {
              const meta = threadMeta(thread);
              return (
                <article key={thread.id} className="rounded-xl border border-surface-border bg-surface/35 p-3.5">
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 ${meta.tone}`}>{thread.stage.startsWith('needs_') ? <AlertTriangle size={17} /> : <Clock3 size={17} />}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-ink">{thread.companyName || 'Компания не указана'}</p>
                        <span className={`text-[11px] font-medium ${meta.tone}`}>{meta.label}</span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-faint">{thread.vacancyTitle}</p>
                      {thread.reason && <p className="mt-2 text-xs leading-relaxed text-ink-muted">{thread.reason}</p>}
                      {thread.offeredSlots.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {thread.offeredSlots.slice(0, 3).map((slot) => <span key={slot} className="pill">{formatFull(slot)}</span>)}
                        </div>
                      )}
                    </div>
                    <button type="button" className="text-ink-faint hover:text-ink" aria-label="Скрыть" onClick={() => void calendar.dismissThread(thread.id).then(setState)}><X size={15} /></button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="panel-card overflow-hidden">
          <div className="panel-header flex-wrap gap-3">
            <div>
              <h2 className="panel-title">Неделя</h2>
              <p className="mt-0.5 text-xs capitalize text-ink-faint">{new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(weekStart)}</p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>Сегодня</button>
              <button type="button" className="skillcue-sidebar__icon-button" aria-label="Предыдущая неделя" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronLeft size={17} /></button>
              <button type="button" className="skillcue-sidebar__icon-button" aria-label="Следующая неделя" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronRight size={17} /></button>
            </div>
          </div>
          <div className="grid min-w-[760px] grid-cols-7 divide-x divide-surface-border overflow-x-auto">
            {weekDays.map((day, index) => {
              const dayEvents = activeEvents
                .filter((event) => sameDay(new Date(event.startAt), day))
                .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt));
              const today = sameDay(day, new Date());
              return (
                <div key={day.toISOString()} className={`min-h-[330px] p-2.5 ${today ? 'bg-emerald-400/[0.035]' : ''}`}>
                  <div className="mb-3 flex items-center justify-between">
                    <span className={`text-xs font-medium ${today ? 'text-emerald-300' : 'text-ink-faint'}`}>{DAYS[index].short}</span>
                    <span className={`grid h-7 w-7 place-items-center rounded-full text-sm font-semibold ${today ? 'bg-emerald-400 text-[#04240f]' : 'text-ink'}`}>{day.getDate()}</span>
                  </div>
                  <div className="space-y-2">
                    {dayEvents.map((event) => {
                      const meta = typeMeta(event.type);
                      return (
                        <article key={event.id} className={`group rounded-xl border p-2.5 ${meta.tone}`}>
                          <p className="text-xs font-bold">{formatTime(event.startAt)}</p>
                          <p className="mt-1 break-words text-xs font-semibold leading-snug text-ink">{event.companyName}</p>
                          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-muted">{event.vacancyTitle}</p>
                          <div className="mt-2 flex items-center justify-between gap-1">
                            <span className="text-[10px]">{event.status === 'confirmed' ? 'Подтверждено' : 'Предварительно'}</span>
                            <button type="button" className="opacity-60 hover:opacity-100" onClick={() => editEvent(event)} aria-label="Изменить"><Pencil size={12} /></button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {activeEvents.length === 0 && <div className="border-t border-surface-border px-5 py-4 text-center text-xs text-ink-faint">Когда время будет согласовано, собеседование появится здесь автоматически.</div>}
        </section>

        <aside id="availability-settings" className="panel-card overflow-hidden">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Когда вам удобно</h2>
              <p className="mt-0.5 text-xs text-ink-faint">Это же расписание используется в автоответах HR</p>
            </div>
          </div>
          <div className="p-4">
            <AvailabilityEditor
              allowClear
              settings={state.settings}
              onSave={saveAvailability}
            />
          </div>
        </aside>
      </div>

      {state.events.length > 0 && (
        <section className="panel-card overflow-hidden">
          <div className="panel-header"><div><h2 className="panel-title">Все ближайшие</h2><p className="mt-0.5 text-xs text-ink-faint">Подробный список созвонов</p></div></div>
          <div className="divide-y divide-surface-border">
            {upcoming.map((event) => {
              const meta = typeMeta(event.type);
              return (
                <div key={event.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <div className="w-36 shrink-0"><p className="text-sm font-semibold text-ink">{formatTime(event.startAt)}</p><p className="text-xs capitalize text-ink-faint">{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' }).format(new Date(event.startAt))}</p></div>
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-ink">{event.companyName}</p><p className="truncate text-xs text-ink-muted">{event.vacancyTitle}</p></div>
                  <span className={`rounded-full border px-2.5 py-1 text-xs ${meta.tone}`}>{meta.label}</span>
                  <span className={`text-xs ${event.status === 'confirmed' ? 'text-emerald-300' : 'text-amber-300'}`}>{event.status === 'confirmed' ? 'Подтверждено' : 'Ждём подтверждения'}</span>
                  {event.meetingUrl && <button type="button" className="btn-ghost btn-sm" onClick={() => openMeeting(event)}><ExternalLink size={14} /> Ссылка</button>}
                  <button type="button" className="skillcue-sidebar__icon-button" onClick={() => editEvent(event)} aria-label="Изменить"><Pencil size={14} /></button>
                  <button type="button" className="skillcue-sidebar__icon-button hover:text-red-300" onClick={() => void removeEvent(event)} aria-label="Удалить"><Trash2 size={14} /></button>
                </div>
              );
            })}
            {upcoming.length === 0 && <p className="px-5 py-6 text-center text-sm text-ink-faint">Предстоящих собеседований нет.</p>}
          </div>
        </section>
      )}

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? 'Изменить собеседование' : 'Добавить собеседование'}
        subtitle="Можно исправить автоматически созданное событие"
        footer={<><button type="button" className="btn-ghost" onClick={() => setForm(null)}>Отмена</button><button type="button" className="btn-primary" disabled={busy === 'event'} onClick={() => void submitEvent()}>{busy === 'event' ? 'Сохраняю…' : 'Сохранить'}</button></>}
      >
        {form && <div className="space-y-3">
          <label><span className="label">Вакансия</span><input className="field" value={form.vacancyTitle} onChange={(event) => setForm({ ...form, vacancyTitle: event.target.value })} placeholder="QA Automation Engineer" /></label>
          <label><span className="label">Компания</span><input className="field" value={form.companyName} onChange={(event) => setForm({ ...form, companyName: event.target.value })} placeholder="Название компании" /></label>
          <div className="grid grid-cols-2 gap-3">
            <label><span className="label">Этап</span><select className="field" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as InterviewType })}><option value="hr">HR</option><option value="technical">Техническое</option><option value="other">Другое</option></select></label>
            <label><span className="label">Статус</span><select className="field" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as EventForm['status'] })}><option value="confirmed">Подтверждено</option><option value="proposed">Предварительно</option></select></label>
          </div>
          <label><span className="label">Дата и время</span><input type="datetime-local" className="field" value={form.startAt} onChange={(event) => setForm({ ...form, startAt: event.target.value })} /></label>
          <label><span className="label">Длительность</span><select className="field" value={form.durationMin} onChange={(event) => setForm({ ...form, durationMin: Number(event.target.value) })}><option value={30}>30 минут</option><option value={45}>45 минут</option><option value={60}>1 час</option><option value={90}>1,5 часа</option><option value={120}>2 часа</option></select></label>
          <label><span className="label">Ссылка на встречу</span><input className="field" value={form.meetingUrl} onChange={(event) => setForm({ ...form, meetingUrl: event.target.value })} placeholder="https://meet.google.com/…" /></label>
          <label><span className="label">Заметка</span><textarea className="field min-h-20 resize-y" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Что подготовить к созвону" /></label>
        </div>}
      </Modal>
    </div>
  );
}
