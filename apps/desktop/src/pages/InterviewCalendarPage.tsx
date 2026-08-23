import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { hhVacancyUrlFromInput } from '../lib/vacancyInput';
import {
  AlertTriangle,
  BookOpen,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CirclePlus,
  Clock3,
  ExternalLink,
  Gauge,
  History,
  Loader2,
  MessageCircle,
  Pencil,
  Play,
  Settings2,
  Sparkles,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import AvailabilityEditor, { AVAILABILITY_DAYS, formatAvailabilitySummary } from '../components/interview/AvailabilityEditor';
import Modal from '../components/Modal';
import { api } from '../lib/api';
import { resolvePreferredResume } from '../lib/resumeContext';
import {
  buildInterviewBrief,
  canReuseStoredVacancyContext,
  findMatchingQueueItem,
  findMatchingVacancySession,
  type InterviewBrief,
} from '../lib/interviewBrief';
import {
  calendarGridBounds,
  calendarSelectionRange,
  moveCalendarGridFocus,
  type CalendarGridNavigationKey,
  type CalendarGridPosition,
} from '../lib/interviewCalendarGrid';
import { formatHomeInterviewBadge } from '../lib/homeRadar';
import { isCompletedInterview, isUpcomingInterview } from '../lib/interviewTiming';
import { analyzeVacancy } from '../lib/vacancyReview/vacancyReviewService';
import { listSessions } from '../lib/vacancyReview/vacancyReviewStore';
import type { VacancyAnalysis } from '../lib/vacancyReview/types';
import type {
  InterviewCalendarEvent,
  InterviewCalendarSettings,
  InterviewCalendarState,
  InterviewEventDraft,
  InterviewSchedulingThread,
  InterviewType,
} from '../types/electron';

const DAYS = AVAILABILITY_DAYS;
const CALENDAR_SLOT_MINUTES = 30;

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

function formatEventEnd(startAt: string, durationMin: number): string {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(start.getTime() + durationMin * 60_000),
  );
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

function InterviewOutcomeView({ event }: { event: InterviewCalendarEvent }) {
  const outcome = event.outcome;
  if (!outcome) {
    return (
      <p className="mt-3 rounded-xl border border-amber-400/15 bg-amber-400/[0.04] px-3 py-2 text-xs text-amber-200">
        {event.sessionId
          ? 'Запись разговора сохранена, но короткий подытог ещё не собран.'
          : 'Оверлей не запускался из этой карточки — итог к созвону не привязан.'}
      </p>
    );
  }
  const sections: Array<[string, string[]]> = [
    ['Что узнали', outcome.facts],
    ['Условия', outcome.conditions],
    ['Что дальше', outcome.nextSteps],
    ['Что уточнить', outcome.openQuestions],
  ];
  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm font-medium leading-relaxed text-ink">{outcome.headline}</p>
      <div className="grid gap-2 md:grid-cols-2">
        {sections.filter(([, items]) => items.length > 0).map(([title, items]) => (
          <section key={title} className="rounded-xl border border-surface-border bg-surface/35 p-3">
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">{title}</h4>
            <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-muted">
              {items.map((item) => <li key={item}>• {item}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

interface EventForm {
  id?: string;
  negotiationKey?: string;
  journeyId?: string;
  sessionId?: string;
  source: 'hh' | 'manual';
  vacancyTitle: string;
  companyName: string;
  type: InterviewType;
  status: 'proposed' | 'confirmed';
  startAt: string;
  durationMin: number;
  vacancyUrl: string;
  vacancyDescription: string;
  meetingUrl: string;
  notes: string;
}

interface InterviewBriefModalState {
  event: InterviewCalendarEvent;
  loading: boolean;
  error: string;
  brief: InterviewBrief | null;
}

interface CalendarDragSelection {
  dayIndex: number;
  startSlot: number;
  currentSlot: number;
}

function durationOptions(selected: number): number[] {
  return [...new Set([
    45,
    ...Array.from({ length: 20 }, (_, index) => (index + 1) * CALENDAR_SLOT_MINUTES),
    selected,
  ])].sort((left, right) => left - right);
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} ч ${remainder} мин` : `${hours} ч`;
}

function emptyEventForm(startAt = defaultStart(), durationMin = 60): EventForm {
  return {
    source: 'manual',
    vacancyTitle: '',
    companyName: '',
    type: 'hr',
    status: 'confirmed',
    startAt,
    durationMin,
    vacancyUrl: '',
    vacancyDescription: '',
    meetingUrl: '',
    notes: '',
  };
}

export default function InterviewCalendarPage() {
  const calendar = window.electronAPI?.interviewCalendar;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<InterviewCalendarState>(EMPTY_STATE);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [focusedSlot, setFocusedSlot] = useState<CalendarGridPosition>({ dayIndex: 0, slotIndex: 0 });
  const [form, setForm] = useState<EventForm | null>(null);
  const [dragSelection, setDragSelection] = useState<CalendarDragSelection | null>(null);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [vacancyImporting, setVacancyImporting] = useState(false);
  const [eventToDelete, setEventToDelete] = useState<InterviewCalendarEvent | null>(null);
  const [briefModal, setBriefModal] = useState<InterviewBriefModalState | null>(null);
  const availabilityInitialized = useRef(false);
  const initialWeekSelected = useRef(false);
  const briefQueryHandled = useRef<string | null>(null);
  const editQueryHandled = useRef<string | null>(null);
  const dragSelectionRef = useRef<CalendarDragSelection | null>(null);
  const finishDragRef = useRef<() => void>(() => {});
  const briefRequestRef = useRef(0);
  const openInterviewBriefRef = useRef<(event: InterviewCalendarEvent) => void>(() => {});
  const editEventRef = useRef<(event: InterviewCalendarEvent) => void>(() => {});
  const briefAnalysisCacheRef = useRef(new Map<string, VacancyAnalysis>());
  const calendarSlotRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!calendar) return;
    let active = true;
    const apply = (next: InterviewCalendarState) => {
      if (!active) return;
      setState(next);
      if (!availabilityInitialized.current) {
        availabilityInitialized.current = true;
        setAvailabilityOpen(!next.settings.availabilityConfigured);
      }
      if (!initialWeekSelected.current) {
        initialWeekSelected.current = true;
        const currentWeek = startOfWeek(new Date());
        const currentWeekEnd = addDays(currentWeek, 7);
        const visibleCurrentWeek = next.events.some((event) => {
          const startsAt = new Date(event.startAt);
          return event.status !== 'cancelled' && startsAt >= currentWeek && startsAt < currentWeekEnd;
        });
        if (!visibleCurrentWeek) {
          const nearest = next.events
            .filter((event) => isUpcomingInterview(event))
            .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt))[0];
          if (nearest) setWeekStart(startOfWeek(new Date(nearest.startAt)));
        }
      }
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
      .filter((event) => isUpcomingInterview(event))
      .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt)),
    [activeEvents],
  );
  const completed = useMemo(
    () => activeEvents
      .filter((event) => isCompletedInterview(event))
      .sort((left, right) => +new Date(right.completedAt ?? right.endAt) - +new Date(left.completedAt ?? left.endAt)),
    [activeEvents],
  );
  const activeThreads = useMemo(
    () => state.scheduling
      .filter((thread) => !thread.hidden && !['confirmed', 'cancelled'].includes(thread.stage))
      .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt)),
    [state.scheduling],
  );
  const calendarBounds = useMemo(() => calendarGridBounds(
    state.settings.availability,
    activeEvents.flatMap((event) => {
      const start = new Date(event.startAt);
      if (!weekDays.some((day) => sameDay(day, start))) return [];
      const end = new Date(event.endAt);
      return [{
        startMinutes: start.getHours() * 60 + start.getMinutes(),
        endMinutes: sameDay(start, end) ? end.getHours() * 60 + end.getMinutes() : 24 * 60,
      }];
    }),
    CALENDAR_SLOT_MINUTES,
  ), [activeEvents, state.settings.availability, weekDays]);
  const calendarSlots = useMemo(() => Array.from(
    { length: (calendarBounds.endMinutes - calendarBounds.startMinutes) / CALENDAR_SLOT_MINUTES },
    (_, index) => calendarBounds.startMinutes + index * CALENDAR_SLOT_MINUTES,
  ), [calendarBounds]);

  useEffect(() => {
    setFocusedSlot((current) => ({
      dayIndex: Math.min(current.dayIndex, Math.max(0, weekDays.length - 1)),
      slotIndex: Math.min(current.slotIndex, Math.max(0, calendarSlots.length - 1)),
    }));
  }, [calendarSlots.length, weekDays.length]);
  const calendarPlacements = useMemo(() => activeEvents.flatMap((event) => {
    const start = new Date(event.startAt);
    const dayIndex = weekDays.findIndex((day) => sameDay(day, start));
    const startMinutes = start.getHours() * 60 + start.getMinutes();
    if (dayIndex < 0 || startMinutes < calendarBounds.startMinutes || startMinutes >= calendarBounds.endMinutes) {
      return [];
    }
    const slotIndex = Math.floor((startMinutes - calendarBounds.startMinutes) / CALENDAR_SLOT_MINUTES);
    const durationMinutes = Math.max(
      CALENDAR_SLOT_MINUTES,
      Math.round((+new Date(event.endAt) - +start) / 60_000),
    );
    const span = Math.min(
      Math.ceil(durationMinutes / CALENDAR_SLOT_MINUTES),
      calendarSlots.length - slotIndex,
    );
    return [{ event, dayIndex, slotIndex, span }];
  }), [activeEvents, calendarBounds, calendarSlots.length, weekDays]);
  const nextInterview = upcoming[0];
  const nextInterviewHasVacancyContext = Boolean(
    nextInterview?.vacancyUrl?.trim() || (nextInterview?.vacancyDescription?.trim().length ?? 0) >= 80,
  );
  const nextInterviewHasMeetingLink = Boolean(nextInterview?.meetingUrl?.trim());

  const openEventAt = (day: Date, minutes: number, durationMin?: number) => {
    const start = new Date(day);
    start.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    setError('');
    setFormError('');
    setForm(emptyEventForm(
      toDateInput(start),
      durationMin ?? state.settings.defaultDurationMin ?? EMPTY_SETTINGS.defaultDurationMin,
    ));
  };

  const beginSlotSelection = (
    dayIndex: number,
    slotIndex: number,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return;
    setFocusedSlot({ dayIndex, slotIndex });
    event.preventDefault();
    const selection = { dayIndex, startSlot: slotIndex, currentSlot: slotIndex };
    dragSelectionRef.current = selection;
    setDragSelection(selection);
  };

  const moveSlotFocus = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    dayIndex: number,
    slotIndex: number,
  ) => {
    const navigationKeys: CalendarGridNavigationKey[] = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
    ];
    if (!navigationKeys.includes(event.key as CalendarGridNavigationKey)) return;
    event.preventDefault();
    const next = moveCalendarGridFocus(
      { dayIndex, slotIndex },
      event.key as CalendarGridNavigationKey,
      weekDays.length,
      calendarSlots.length,
    );
    setFocusedSlot(next);
    window.requestAnimationFrame(() => {
      calendarSlotRefs.current.get(`${next.dayIndex}-${next.slotIndex}`)?.focus();
    });
  };

  const extendSlotSelection = (dayIndex: number, slotIndex: number) => {
    const current = dragSelectionRef.current;
    if (!current || current.dayIndex !== dayIndex || current.currentSlot === slotIndex) return;
    const next = { ...current, currentSlot: slotIndex };
    dragSelectionRef.current = next;
    setDragSelection(next);
  };

  const finishSlotSelection = () => {
    const selection = dragSelectionRef.current;
    if (!selection) return;
    dragSelectionRef.current = null;
    setDragSelection(null);
    const range = calendarSelectionRange(
      selection.startSlot,
      selection.currentSlot,
      calendarBounds.startMinutes,
      CALENDAR_SLOT_MINUTES,
    );
    openEventAt(
      weekDays[selection.dayIndex],
      range.startMinutes,
      range.durationMin,
    );
  };

  finishDragRef.current = finishSlotSelection;

  useEffect(() => {
    const finish = () => finishDragRef.current();
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, []);

  const saveAvailability = async (settings: Partial<InterviewCalendarSettings>) => {
    if (!calendar) return;
    setBusy('settings');
    setError('');
    try {
      const next = await calendar.saveSettings(settings);
      setState(next);
      setAvailabilityOpen(false);
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
    if (!form) return;
    if (!calendar) {
      setFormError('Календарь пока недоступен. Перезапустите приложение и попробуйте ещё раз.');
      return;
    }
    let resolvedForm = form;
    const normalizedHhUrl = hhVacancyUrlFromInput([
      form.vacancyUrl,
      form.vacancyTitle,
      form.companyName,
    ].join('\n'));
    const titleContainsHhUrl = Boolean(hhVacancyUrlFromInput(form.vacancyTitle));
    const companyContainsHhUrl = Boolean(hhVacancyUrlFromInput(form.companyName));
    const needsVacancyImport = Boolean(normalizedHhUrl && (
      !form.vacancyTitle.trim()
      || !form.companyName.trim()
      || titleContainsHhUrl
      || companyContainsHhUrl
      || form.vacancyDescription.trim().length < 80
    ));
    if (needsVacancyImport && normalizedHhUrl) {
      const assistant = window.electronAPI?.hhAssistant;
      if (!assistant) {
        if (!form.vacancyTitle.trim() || !form.companyName.trim() || titleContainsHhUrl || companyContainsHhUrl) {
          setFormError('Не удалось загрузить данные вакансии. Попробуйте ещё раз или укажите название и компанию.');
          return;
        }
      } else {
        setVacancyImporting(true);
        try {
          const vacancy = await assistant.inspectVacancyUrl(normalizedHhUrl);
          resolvedForm = {
            ...form,
            vacancyTitle: !form.vacancyTitle.trim() || titleContainsHhUrl ? vacancy.title : form.vacancyTitle,
            companyName: !form.companyName.trim() || companyContainsHhUrl ? vacancy.company : form.companyName,
            vacancyUrl: vacancy.url || normalizedHhUrl,
            vacancyDescription: form.vacancyDescription.trim() || vacancy.description || vacancy.text,
          };
          setForm(resolvedForm);
        } catch (reason) {
          if (!form.vacancyTitle.trim() || !form.companyName.trim() || titleContainsHhUrl || companyContainsHhUrl) {
            setFormError(reason instanceof Error ? reason.message : 'Не удалось загрузить вакансию с HH.');
            return;
          }
          resolvedForm = { ...form, vacancyUrl: normalizedHhUrl };
        } finally {
          setVacancyImporting(false);
        }
      }
    }
    if (!resolvedForm.vacancyTitle.trim() || !resolvedForm.companyName.trim() || !resolvedForm.startAt) {
      setFormError(normalizedHhUrl
        ? 'Не удалось определить название или компанию. Заполните только недостающее поле.'
        : 'Добавьте ссылку HH или укажите вакансию и компанию.');
      return;
    }
    const start = new Date(resolvedForm.startAt);
    if (Number.isNaN(start.getTime())) {
      setFormError('Не удалось распознать дату встречи.');
      return;
    }
    setBusy('event');
    setFormError('');
    const draft: InterviewEventDraft = {
      id: form.id,
      negotiationKey: form.negotiationKey,
      journeyId: form.journeyId,
      sessionId: form.sessionId,
      vacancyTitle: resolvedForm.vacancyTitle.trim(),
      companyName: resolvedForm.companyName.trim(),
      type: form.type,
      status: form.status,
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + form.durationMin * 60_000).toISOString(),
      source: form.source,
      vacancyUrl: resolvedForm.vacancyUrl.trim() || undefined,
      vacancyDescription: resolvedForm.vacancyDescription.trim() || undefined,
      meetingUrl: form.meetingUrl.trim() || undefined,
      notes: form.notes.trim() || undefined,
    };
    try {
      setState(await calendar.upsertEvent(draft));
      setForm(null);
      setFormError('');
      setMessage(form.id ? 'Собеседование обновлено.' : 'Собеседование добавлено.');
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  const editEvent = (event: InterviewCalendarEvent) => {
    setFormError('');
    setForm({
      id: event.id,
      negotiationKey: event.negotiationKey,
      journeyId: event.journeyId,
      sessionId: event.sessionId,
      source: event.source,
      vacancyTitle: event.vacancyTitle,
      companyName: event.companyName,
      type: event.type,
      status: event.status === 'cancelled' ? 'proposed' : event.status,
      startAt: toDateInput(new Date(event.startAt)),
      durationMin: Math.max(15, Math.round((+new Date(event.endAt) - +new Date(event.startAt)) / 60_000)),
      vacancyUrl: event.vacancyUrl ?? '',
      vacancyDescription: event.vacancyDescription ?? '',
      meetingUrl: event.meetingUrl ?? '',
      notes: event.notes ?? '',
    });
  };
  editEventRef.current = editEvent;

  const addNextStage = (event: InterviewCalendarEvent) => {
    setFormError('');
    setForm({
      ...emptyEventForm(defaultStart(), state.settings.defaultDurationMin ?? EMPTY_SETTINGS.defaultDurationMin),
      journeyId: event.journeyId ?? event.id,
      source: event.source,
      vacancyTitle: event.vacancyTitle,
      companyName: event.companyName,
      type: event.type === 'hr' ? 'technical' : 'other',
      vacancyUrl: event.vacancyUrl ?? '',
      vacancyDescription: event.vacancyDescription ?? '',
    });
  };

  const confirmRemoveEvent = async (event: InterviewCalendarEvent) => {
    if (!calendar) return;
    setBusy(`delete:${event.id}`);
    setError('');
    try {
      setState(await calendar.removeEvent(event.id));
      setEventToDelete(null);
      if (form?.id === event.id) setForm(null);
      setMessage('Собеседование удалено из календаря.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  const startInterview = async (event: InterviewCalendarEvent) => {
    setBusy(`preflight:${event.id}`);
    setError('');
    setMessage('Проверяю ИИ реальным вопросом перед созвоном…');
    try {
      const readiness = await api.providerReadiness();
      if (!readiness.ok) {
        setMessage('');
        setError('ИИ ответил, но проверка качества не пройдена. Созвон не запущен — проверьте модель или ключ.');
        return;
      }
      setMessage(`ИИ готов: ${readiness.model}, ответ за ${(readiness.latency_ms / 1000).toFixed(1)} с.`);
    } catch (reason) {
      setMessage('');
      setError(`ИИ не готов к созвону: ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    } finally {
      setBusy('');
    }
    const launch = window.electronAPI?.overlay.showForInterviewEvent;
    if (!launch) {
      navigate('/overlay');
      return;
    }
    const started = await launch(event.id);
    if (started === false) setError('Не удалось связать оверлей с этим созвоном.');
  };

  const openMeeting = (event: InterviewCalendarEvent) => {
    if (event.meetingUrl) void window.electronAPI?.openExternal(event.meetingUrl);
  };

  const closeInterviewBrief = () => {
    briefRequestRef.current += 1;
    setBriefModal(null);
  };

  const openInterviewBrief = async (event: InterviewCalendarEvent) => {
    const requestId = ++briefRequestRef.current;
    setBriefModal({ event, loading: true, error: '', brief: null });

    const mayReuseStoredContext = canReuseStoredVacancyContext(event);
    const sessions = mayReuseStoredContext ? listSessions() : [];
    const session = mayReuseStoredContext
      ? findMatchingVacancySession(event, sessions)
      : null;
    let analysis = session?.vacancyAnalysis
      ?? briefAnalysisCacheRef.current.get(`${event.id}:${event.updatedAt}`)
      ?? null;
    let vacancyText = event.vacancyDescription?.trim() || analysis?.vacancyText || '';
    let vacancyUrl = event.vacancyUrl?.trim() || analysis?.vacancyUrl || '';
    let preparationNotes: string[] = [];
    let selectedResumeTitle = analysis?.resumeSource?.kind === 'hh'
      ? analysis.resumeSource.title
      : '';
    const assistant = window.electronAPI?.hhAssistant;

    try {
      if (assistant && mayReuseStoredContext) {
        const hhState = await assistant.getState();
        const queueItem = findMatchingQueueItem(event, hhState.queue);
        if (queueItem) {
          vacancyText ||= queueItem.description?.trim() || '';
          vacancyUrl ||= queueItem.url;
          preparationNotes = queueItem.preparationNotes ?? [];
          selectedResumeTitle ||= queueItem.selectedResumeTitle ?? '';
        }
      }
    } catch {
      // A manually saved vacancy is still enough to build the brief.
    }

    const isHhVacancy = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?hh\.ru\//i.test(vacancyUrl);
    if (assistant && vacancyText.length < 80 && vacancyUrl && isHhVacancy) {
      try {
        const vacancy = await assistant.inspectVacancyUrl(vacancyUrl);
        vacancyText = vacancy.description || vacancy.text || vacancyText;
        vacancyUrl = vacancy.url || vacancyUrl;
      } catch {
        // The modal below explains how to add the description manually.
      }
    }

    if (!analysis && vacancyText.trim().length >= 80) {
      let profileText = '';
      try {
        profileText = (await api.profilePackGet()).content.trim();
      } catch {
        // Fall back to the current HH résumé below.
      }
      if (!profileText) {
        const preferred = await resolvePreferredResume(selectedResumeTitle);
        profileText = preferred.text;
        if (!selectedResumeTitle && preferred.source?.title) {
          selectedResumeTitle = preferred.source.title;
        }
      }
      analysis = await analyzeVacancy({
        vacancyText,
        vacancyUrl: vacancyUrl || undefined,
        vacancyCompany: event.companyName,
        targetRole: event.vacancyTitle,
        language: 'ru',
        resumeText: profileText || undefined,
        resumeSource: selectedResumeTitle ? { kind: 'hh', title: selectedResumeTitle } : undefined,
      });
      briefAnalysisCacheRef.current.set(`${event.id}:${event.updatedAt}`, analysis);
    }

    const brief = buildInterviewBrief({
      event,
      analysis,
      session,
      vacancyText,
      preparationNotes,
      calendarEvents: state.events,
    });
    if (briefRequestRef.current !== requestId) return;
    const briefError = !brief.hasVacancyDetails
      ? 'Не нашёл полное описание вакансии. Добавьте ссылку HH или вставьте требования в карточку встречи — тогда оценка и план станут точными.'
      : analysis && !analysis.hasResume
        ? 'Требования вакансии разобраны, но профиль кандидата не загрузился. Поэтому процент готовности не придуман.'
        : '';
    setBriefModal({ event, loading: false, error: briefError, brief });
  };
  openInterviewBriefRef.current = (event) => { void openInterviewBrief(event); };

  useEffect(() => {
    const eventId = searchParams.get('brief');
    if (!eventId || briefQueryHandled.current === eventId) return;
    const event = state.events.find((item) => item.id === eventId && item.status !== 'cancelled');
    if (!event) return;
    briefQueryHandled.current = eventId;
    setWeekStart(startOfWeek(new Date(event.startAt)));
    openInterviewBriefRef.current(event);
  }, [searchParams, state.events]);

  useEffect(() => {
    const eventId = searchParams.get('edit');
    if (!eventId || editQueryHandled.current === eventId) return;
    const event = state.events.find((item) => item.id === eventId && item.status !== 'cancelled');
    if (!event) return;
    editQueryHandled.current = eventId;
    setWeekStart(startOfWeek(new Date(event.startAt)));
    editEventRef.current(event);
  }, [searchParams, state.events]);

  const readinessEditActive = Boolean(form?.id && searchParams.get('edit') === form.id);
  const readinessEditMissing = form ? [
    form.vacancyUrl.trim() || form.vacancyDescription.trim().length >= 80 ? '' : 'требования вакансии',
    form.meetingUrl.trim() ? '' : 'ссылку на встречу',
  ].filter(Boolean) : [];
  const readinessEditSubtitle = readinessEditMissing.length > 0
    ? `Добавьте ${readinessEditMissing.join(' и ')}. Остальные поля уже заполнены.`
    : 'Все данные для подготовки уже заполнены.';

  if (!calendar) {
    return <div className="panel-card p-6 text-sm text-ink-muted">Календарь доступен в приложении SkillCue для компьютера.</div>;
  }

  return (
    <div className="flex min-h-full flex-col gap-5 pb-14">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">
            <CalendarDays size={15} /> Собеседования
          </div>
          <h1 className="page-title">Календарь созвонов</h1>
        </div>
        <button type="button" className="btn-secondary" onClick={() => { setFormError(''); setForm(emptyEventForm()); }}>
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
        <section className="interview-next-banner" aria-label={`Ближайшее собеседование: ${formatHomeInterviewBadge(nextInterview.startAt, new Date())}`}>
          <div className="interview-next-banner__icon"><Clock3 size={21} /></div>
          <div className="interview-next-banner__copy">
            <div className="interview-next-banner__heading">
              <p>Ближайшее собеседование</p>
              <span><CalendarDays size={13} /> {formatHomeInterviewBadge(nextInterview.startAt, new Date())}</span>
            </div>
            <p className="interview-next-banner__title">{nextInterview.companyName} · {nextInterview.vacancyTitle}</p>
            <p className="interview-next-banner__date">{formatFull(nextInterview.startAt)}</p>
            {(!nextInterviewHasVacancyContext || !nextInterviewHasMeetingLink) && <div className="interview-next-banner__notes">
              {!nextInterviewHasVacancyContext && <span className="is-attention">Требования вакансии не добавлены</span>}
              {!nextInterviewHasMeetingLink && <span>Нет ссылки на созвон</span>}
            </div>}
          </div>
          <div className="interview-next-banner__actions">
            <span className={`rounded-full border px-2.5 py-1 text-xs ${typeMeta(nextInterview.type).tone}`}>{typeMeta(nextInterview.type).label}</span>
            {nextInterviewHasVacancyContext
              ? <button type="button" className="btn-secondary" onClick={() => void openInterviewBrief(nextInterview)}><Sparkles size={15} /> Что ждёт на созвоне</button>
              : <button type="button" className="btn-secondary" onClick={() => editEvent(nextInterview)}><Pencil size={15} /> Дополнить вакансию</button>}
            <button type="button" className="btn-primary" onClick={() => void startInterview(nextInterview)}><Play size={15} /> Начать с оверлеем</button>
            {nextInterview.meetingUrl && <button type="button" className="btn-primary" onClick={() => openMeeting(nextInterview)}><ExternalLink size={15} /> Открыть ссылку</button>}
          </div>
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

      <div className="grid items-start gap-5">
        <section className="panel-card overflow-hidden">
          <div className="panel-header flex-wrap gap-3">
            <div>
              <h2 className="panel-title">Неделя</h2>
              <p className="mt-0.5 text-xs text-ink-faint">{new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(weekStart)} · Нажмите или протяните по времени, чтобы добавить собеседование</p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <button type="button" className="btn-ghost btn-sm" onClick={() => setWeekStart(startOfWeek(new Date()))}>Сегодня</button>
              <button type="button" className="skillcue-sidebar__icon-button" aria-label="Предыдущая неделя" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronLeft size={17} /></button>
              <button type="button" className="skillcue-sidebar__icon-button" aria-label="Следующая неделя" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronRight size={17} /></button>
            </div>
          </div>
          <div className="interview-week-scroll">
            <div
              className="interview-week-grid"
              role="grid"
              aria-label="Календарь собеседований на неделю"
              aria-rowcount={calendarSlots.length + 1}
              aria-colcount={weekDays.length + 1}
              style={{ gridTemplateRows: `58px repeat(${calendarSlots.length}, 24px)` }}
            >
              <div className="contents" role="row">
                <div className="interview-week-corner" role="columnheader" aria-label="Время" />
                {weekDays.map((day, index) => {
                  const today = sameDay(day, new Date());
                  return (
                    <div
                      key={`header-${day.toISOString()}`}
                      role="columnheader"
                      className={`interview-week-day ${today ? 'is-today' : ''}`}
                      style={{ gridColumn: index + 2, gridRow: 1 }}
                    >
                      <span>{DAYS[index].short}</span>
                      <strong>{day.getDate()}</strong>
                    </div>
                  );
                })}
              </div>

              {calendarSlots.map((minutes, slotIndex) => {
                const time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
                return (
                  <div key={`slot-${minutes}`} className="contents" role="row">
                    <div
                      className="interview-week-time"
                      role="rowheader"
                      style={{ gridColumn: 1, gridRow: slotIndex + 2 }}
                    >
                      {minutes % 60 === 0 ? time : ''}
                    </div>
                    {weekDays.map((day, dayIndex) => (
                      <button
                        key={`${day.toISOString()}-${minutes}`}
                        type="button"
                        role="gridcell"
                        tabIndex={focusedSlot.dayIndex === dayIndex && focusedSlot.slotIndex === slotIndex ? 0 : -1}
                        ref={(node) => {
                          const key = `${dayIndex}-${slotIndex}`;
                          if (node) calendarSlotRefs.current.set(key, node);
                          else calendarSlotRefs.current.delete(key);
                        }}
                        className={`interview-week-slot ${sameDay(day, new Date()) ? 'is-today' : ''} ${dragSelection?.dayIndex === dayIndex && slotIndex >= Math.min(dragSelection.startSlot, dragSelection.currentSlot) && slotIndex <= Math.max(dragSelection.startSlot, dragSelection.currentSlot) ? 'is-selecting' : ''}`}
                        style={{ gridColumn: dayIndex + 2, gridRow: slotIndex + 2 }}
                        aria-label={`Добавить собеседование: ${DAYS[dayIndex].label}, ${day.getDate()}, ${time}`}
                        title={`Нажмите или протяните от ${time}`}
                        onPointerDown={(event) => beginSlotSelection(dayIndex, slotIndex, event)}
                        onFocus={() => setFocusedSlot({ dayIndex, slotIndex })}
                        onKeyDown={(event) => moveSlotFocus(event, dayIndex, slotIndex)}
                        onPointerEnter={() => extendSlotSelection(dayIndex, slotIndex)}
                        onPointerUp={finishSlotSelection}
                        onClick={(event) => {
                          if (event.detail === 0) openEventAt(day, minutes, CALENDAR_SLOT_MINUTES);
                        }}
                        onDragStart={(event) => event.preventDefault()}
                      >
                        <span className="interview-week-slot__hint"><CirclePlus size={14} />{time}</span>
                      </button>
                    ))}
                  </div>
                );
              })}

              {dragSelection && (() => {
                const range = calendarSelectionRange(
                  dragSelection.startSlot,
                  dragSelection.currentSlot,
                  calendarBounds.startMinutes,
                  CALENDAR_SLOT_MINUTES,
                );
                return (
                  <div
                    className="interview-week-selection"
                    style={{
                      gridColumn: dragSelection.dayIndex + 2,
                      gridRow: `${range.firstSlot + 2} / span ${range.lastSlot - range.firstSlot + 1}`,
                    }}
                    aria-hidden="true"
                  >
                    <strong>{`${pad(Math.floor(range.startMinutes / 60))}:${pad(range.startMinutes % 60)}–${pad(Math.floor(range.endMinutes / 60))}:${pad(range.endMinutes % 60)}`}</strong>
                    <span>{formatDuration(range.durationMin)}</span>
                  </div>
                );
              })()}

              {calendarPlacements.map(({ event, dayIndex, slotIndex, span }) => {
                const meta = typeMeta(event.type);
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={`interview-week-event ${span === 1 ? 'is-compact' : ''} ${meta.tone}`}
                    style={{
                      gridColumn: dayIndex + 2,
                      gridRow: `${slotIndex + 2} / span ${span}`,
                    }}
                    aria-label={`Изменить: ${event.companyName}, ${formatTime(event.startAt)}`}
                    onClick={() => editEvent(event)}
                  >
                    <span className="interview-week-event__headline">
                      <span className="interview-week-event__time">{formatTime(event.startAt)}</span>
                      <strong title={event.companyName}>{event.companyName}</strong>
                    </span>
                    <small title={event.vacancyTitle}>{event.vacancyTitle}</small>
                    <Pencil className="interview-week-event__edit" size={12} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <aside id="availability-settings" className="panel-card overflow-hidden">
          <div className="panel-header flex-wrap gap-3">
            <div>
              <h2 className="panel-title">Когда вам удобно</h2>
              <p className="mt-0.5 text-xs text-ink-faint">Это же расписание используется в автоответах HR</p>
            </div>
            <button type="button" className="btn-ghost btn-sm ml-auto" aria-expanded={availabilityOpen} onClick={() => setAvailabilityOpen((open) => !open)}>
              {availabilityOpen ? 'Свернуть' : state.settings.availabilityConfigured ? 'Изменить' : 'Настроить'}
            </button>
          </div>
          {availabilityOpen ? (
            <div className="p-4">
              <AvailabilityEditor
                allowClear
                compact
                settings={state.settings}
                onSave={saveAvailability}
              />
            </div>
          ) : (
            <button type="button" className="block w-full border-t border-surface-border px-4 py-3 text-left hover:bg-surface-hover/40" onClick={() => setAvailabilityOpen(true)}>
              <span className="block text-xs font-medium text-ink-muted">{formatAvailabilitySummary(state.settings)}</span>
              <span className="mt-1 block text-[11px] text-ink-faint">Нажмите, чтобы изменить дни и время</span>
            </button>
          )}
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
                  <div className="w-36 shrink-0"><p className="text-sm font-semibold text-ink">{formatTime(event.startAt)}</p><p className="text-xs text-ink-faint">{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' }).format(new Date(event.startAt))}</p></div>
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-ink">{event.companyName}</p><p className="truncate text-xs text-ink-muted">{event.vacancyTitle}</p></div>
                  <span className={`rounded-full border px-2.5 py-1 text-xs ${meta.tone}`}>{meta.label}</span>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => void openInterviewBrief(event)}><BookOpen size={14} /> Подготовка</button>
                  <button type="button" className="btn-primary btn-sm" onClick={() => void startInterview(event)}><Play size={14} /> Начать</button>
                  <span className={`text-xs ${event.status === 'confirmed' ? 'text-emerald-300' : 'text-amber-300'}`}>{event.status === 'confirmed' ? 'Подтверждено' : 'Ждём подтверждения'}</span>
                  {event.meetingUrl && <button type="button" className="btn-ghost btn-sm" onClick={() => openMeeting(event)}><ExternalLink size={14} /> Ссылка</button>}
                  <button type="button" className="skillcue-sidebar__icon-button" onClick={() => editEvent(event)} aria-label="Изменить"><Pencil size={14} /></button>
                  <button type="button" className="skillcue-sidebar__icon-button hover:text-red-300" onClick={() => setEventToDelete(event)} aria-label="Удалить"><Trash2 size={14} /></button>
                </div>
              );
            })}
            {upcoming.length === 0 && <p className="px-5 py-6 text-center text-sm text-ink-faint">Предстоящих собеседований нет.</p>}
          </div>
        </section>
      )}

      {completed.length > 0 && (
        <section className="panel-card overflow-hidden">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Прошедшие созвоны</h2>
              <p className="mt-0.5 text-xs text-ink-faint">Что узнали по каждой вакансии и о чём договорились</p>
            </div>
          </div>
          <div className="divide-y divide-surface-border">
            {completed.map((event) => {
              const meta = typeMeta(event.type);
              const journeyKey = event.journeyId ?? event.id;
              const journeyEvents = activeEvents
                .filter((item) => (item.journeyId ?? item.id) === journeyKey)
                .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt));
              const journeyIndex = journeyEvents.findIndex((item) => item.id === event.id);
              return (
                <article key={event.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-ink">{event.companyName} · {event.vacancyTitle}</h3>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${meta.tone}`}>{meta.label}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {formatFull(event.startAt)}
                        {journeyEvents.length > 1 && journeyIndex >= 0 ? ` · этап ${journeyIndex + 1} из ${journeyEvents.length}` : ''}
                      </p>
                    </div>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => addNextStage(event)}><CirclePlus size={14} /> Следующий этап</button>
                    <button type="button" className="skillcue-sidebar__icon-button" onClick={() => editEvent(event)} aria-label="Изменить"><Pencil size={14} /></button>
                    <button type="button" className="skillcue-sidebar__icon-button hover:text-red-300" onClick={() => setEventToDelete(event)} aria-label="Удалить"><Trash2 size={14} /></button>
                  </div>
                  <InterviewOutcomeView event={event} />
                </article>
              );
            })}
          </div>
        </section>
      )}

      <Modal
        open={Boolean(briefModal)}
        onClose={closeInterviewBrief}
        size="xl"
        title="Подготовка к собеседованию"
        subtitle={briefModal ? `${briefModal.event.companyName} · ${briefModal.event.vacancyTitle} · ${formatFull(briefModal.event.startAt)}` : ''}
        footer={<>
          {briefModal && <button type="button" className="btn-ghost mr-auto" onClick={() => {
            const selectedEvent = briefModal.event;
            closeInterviewBrief();
            editEvent(selectedEvent);
          }}><Pencil size={14} /> Дополнить вакансию</button>}
          {briefModal?.brief?.sourceSessionId && <button type="button" className="btn-secondary" onClick={() => {
            const sessionId = briefModal.brief?.sourceSessionId;
            if (!sessionId) return;
            closeInterviewBrief();
            navigate(`/prepare?session=${encodeURIComponent(sessionId)}`);
          }}><BookOpen size={14} /> Полный разбор</button>}
          <button type="button" className="btn-primary" onClick={closeInterviewBrief}>Закрыть</button>
        </>}
      >
        {briefModal?.loading && (
          <div className="flex min-h-72 flex-col items-center justify-center text-center">
            <Loader2 className="animate-spin text-emerald-300" size={28} />
            <p className="mt-3 text-sm font-medium text-ink">Собираю подготовку</p>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-ink-muted">Сверяю вакансию с профилем и поднимаю предыдущие HR-созвоны этой компании.</p>
          </div>
        )}
        {!briefModal?.loading && briefModal?.brief && (() => {
          const brief = briefModal.brief;
          if (!brief.hasVacancyDetails) {
            return <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] px-6 text-center">
              <AlertTriangle className="text-amber-300" size={28} />
              <h3 className="mt-4 text-base font-semibold text-ink">Недостаточно данных для подготовки</h3>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-muted">
                В карточке есть только компания, название и время. Поэтому SkillCue не рассчитывает процент готовности и не придумывает сильные стороны, риски или технические темы. Добавьте ссылку HH либо описание вакансии.
              </p>
            </div>;
          }
          const scoreTone = brief.readinessScore == null
            ? 'border-amber-400/25 bg-amber-400/[0.06] text-amber-200'
            : brief.readinessScore >= 70
              ? 'border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-200'
              : 'border-orange-400/25 bg-orange-400/[0.06] text-orange-200';
          return <div className="space-y-4">
            {briefModal.error && <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3 text-xs leading-relaxed text-amber-100"><AlertTriangle className="mr-2 inline-block" size={15} />{briefModal.error}</div>}

            <div className="grid gap-4 lg:grid-cols-[0.75fr_1.25fr]">
              <section className={`rounded-2xl border p-4 ${scoreTone}`}>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em]"><Gauge size={16} /> Насколько вы готовы</div>
                <div className="mt-4 flex items-end gap-3">
                  <strong className="text-4xl leading-none">{brief.readinessScore == null ? '—' : `${brief.readinessScore}%`}</strong>
                  <span className="pb-0.5 text-sm font-semibold">{brief.readinessLabel}</span>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-ink-muted">{brief.readinessBasis}</p>
              </section>

              <section className="rounded-2xl border border-surface-border bg-surface/35 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-violet-200"><Target size={16} /> Что будет на этом этапе</div>
                <p className="mt-3 text-sm leading-relaxed text-ink">{brief.stageSummary}</p>
                {brief.likelyTopics.length > 0 ? <ul className="mt-3 grid gap-1.5 text-xs leading-relaxed text-ink-muted sm:grid-cols-2">{brief.likelyTopics.map((item) => <li key={item} className="flex gap-2"><span className="text-violet-300">•</span><span>{item}</span></li>)}</ul> : <p className="mt-3 text-xs text-ink-faint">Добавьте требования вакансии — появятся вероятные технические темы.</p>}
              </section>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <section className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-emerald-200"><CheckCircle2 size={16} /> Сильные стороны</div>
                {brief.strengths.length > 0 ? <ul className="mt-3 space-y-2 text-xs leading-relaxed text-ink-muted">{brief.strengths.map((item) => <li key={item}>• {item}</li>)}</ul> : <p className="mt-3 text-xs leading-relaxed text-ink-faint">Пока недостаточно данных, чтобы честно назвать сильные совпадения.</p>}
              </section>
              <section className="rounded-2xl border border-orange-400/20 bg-orange-400/[0.04] p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-orange-200"><AlertTriangle size={16} /> Риски и пробелы</div>
                {brief.weakAreas.length > 0 ? <ul className="mt-3 space-y-2 text-xs leading-relaxed text-ink-muted">{brief.weakAreas.map((item) => <li key={item}>• {item}</li>)}</ul> : <p className="mt-3 text-xs leading-relaxed text-ink-faint">Критичных пробелов по доступным данным не найдено.</p>}
              </section>
              <section className="rounded-2xl border border-sky-400/20 bg-sky-400/[0.04] p-4">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-sky-200"><BookOpen size={16} /> Что повторить до созвона</div>
                {brief.studyPlan.length > 0 ? <ul className="mt-3 space-y-2 text-xs leading-relaxed text-ink-muted">{brief.studyPlan.map((item) => <li key={item}>• {item}</li>)}</ul> : <p className="mt-3 text-xs leading-relaxed text-ink-faint">Точный план появится после загрузки требований вакансии.</p>}
              </section>
            </div>

            <section className="rounded-2xl border border-surface-border bg-surface/35 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-sky-200"><Building2 size={16} /> О компании — кратко</div>
              {brief.companyOverview.length > 0 ? <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">{brief.companyOverview.map((item) => <li key={item}>• {item}</li>)}</ul> : <p className="mt-3 text-xs leading-relaxed text-ink-faint">В описании вакансии не нашлось достоверного краткого блока о компании.</p>}
            </section>

            <section className="rounded-2xl border border-surface-border bg-surface/35 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-violet-200"><History size={16} /> Прошлые HR-созвоны с этой компанией</div>
                <span className="text-[11px] text-ink-faint">Только этапы с типом HR</span>
              </div>
              {brief.previousHrCalls.length > 0 ? <div className="mt-3 grid gap-3 md:grid-cols-2">{brief.previousHrCalls.map((call) => <article key={call.id} className="rounded-xl border border-surface-border bg-surface-light/50 p-3">
                <p className="text-xs text-ink-faint">{formatFull(call.date)}</p>
                <p className="mt-1 text-sm font-medium leading-relaxed text-ink">{call.summary}</p>
                {call.details.length > 0 && <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">{call.details.map((item) => <li key={item}>• {item}</li>)}</ul>}
              </article>)}</div> : <p className="mt-3 text-xs leading-relaxed text-ink-faint">Предыдущих HR-созвонов с этой компанией в календаре пока нет.</p>}
            </section>
          </div>;
        })()}
      </Modal>

      <Modal
        open={Boolean(form)}
        onClose={() => { setForm(null); setFormError(''); }}
        size="lg"
        title={readinessEditActive ? 'Данные для 100% готовности' : form?.id ? 'Изменить собеседование' : 'Новое собеседование'}
        subtitle={readinessEditActive
          ? readinessEditSubtitle
          : form ? formatFull(form.startAt) : ''}
        footer={<>
          {formError && <span className="mr-auto self-center text-xs text-red-300" role="alert">{formError}</span>}
          {form?.id && <button type="button" className="btn-ghost mr-auto text-red-300" onClick={() => {
            const event = state.events.find((item) => item.id === form.id);
            if (event) setEventToDelete(event);
          }}><Trash2 size={14} /> Удалить</button>}
          <button type="button" className="btn-ghost" onClick={() => { setForm(null); setFormError(''); }}>Отмена</button>
          <button type="button" className="btn-primary" disabled={busy === 'event' || vacancyImporting} onClick={() => void submitEvent()}>{busy === 'event' || vacancyImporting ? 'Загружаю…' : 'Сохранить'}</button>
        </>}
      >
        {form && <div className="space-y-3" aria-describedby={formError ? 'interview-form-error' : undefined}>
          <span id="interview-form-error" className="sr-only">{formError}</span>
          {!form.id && (
            <label>
              <span className="label">Ссылка HH <span className="font-normal text-ink-faint">· название и компания заполнятся сами</span></span>
              <input autoFocus className="field" value={form.vacancyUrl} onChange={(event) => { setForm({ ...form, vacancyUrl: event.target.value }); setFormError(''); }} placeholder="https://hh.ru/vacancy/…" />
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label><span className="label">Вакансия</span><input autoFocus={Boolean(form.id && !readinessEditActive)} className="field" value={form.vacancyTitle} aria-invalid={Boolean(formError && !form.vacancyTitle.trim())} onChange={(event) => { setForm({ ...form, vacancyTitle: event.target.value }); setFormError(''); }} placeholder="QA Automation Engineer" /></label>
            <label><span className="label">Компания</span><input className="field" value={form.companyName} aria-invalid={Boolean(formError && !form.companyName.trim())} onChange={(event) => { setForm({ ...form, companyName: event.target.value }); setFormError(''); }} placeholder="Название компании" /></label>
          </div>
          {readinessEditActive && !form.meetingUrl.trim() && (
            <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] p-3">
              <label>
                <span className="label text-emerald-200">Ссылка на встречу <span className="font-normal text-ink-faint">(не хватает для 100%)</span></span>
                <input autoFocus className="field" value={form.meetingUrl} onChange={(event) => setForm({ ...form, meetingUrl: event.target.value })} placeholder="https://meet.google.com/…" />
              </label>
            </div>
          )}
          <details className="rounded-xl border border-surface-border bg-surface/25 px-3 py-2.5" open={readinessEditActive || undefined}>
            <summary className="cursor-pointer text-xs font-semibold text-ink-muted">Добавить ссылку или требования <span className="font-normal text-ink-faint">· необязательно</span></summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {form.id && <label><span className="label">Ссылка на вакансию</span><input className="field" value={form.vacancyUrl} onChange={(event) => { setForm({ ...form, vacancyUrl: event.target.value }); setFormError(''); }} placeholder="https://hh.ru/vacancy/…" /></label>}
              <label><span className="label">Описание / требования</span><textarea className="field min-h-10 resize-y" rows={1} value={form.vacancyDescription} onChange={(event) => setForm({ ...form, vacancyDescription: event.target.value })} placeholder="Стек, задачи, требования" /></label>
            </div>
          </details>
          <div className="grid grid-cols-2 gap-3">
            <label><span className="label">Этап</span><select className="field" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as InterviewType })}><option value="hr">HR</option><option value="technical">Техническое</option><option value="other">Другое</option></select></label>
            <label><span className="label">Статус</span><select className="field" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as EventForm['status'] })}><option value="confirmed">Подтверждено</option><option value="proposed">Предварительно</option></select></label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label><span className="label">Начало</span><input type="datetime-local" className="field" value={form.startAt} onChange={(event) => setForm({ ...form, startAt: event.target.value })} /></label>
            <label><span className="label">Окончание</span><select className="field" value={form.durationMin} onChange={(event) => setForm({ ...form, durationMin: Number(event.target.value) })}>{durationOptions(form.durationMin).map((minutes) => <option key={minutes} value={minutes}>до {formatEventEnd(form.startAt, minutes)}</option>)}</select></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {!readinessEditActive && <label><span className="label">Ссылка на встречу <span className="font-normal text-ink-faint">· необязательно</span></span><input className="field" value={form.meetingUrl} onChange={(event) => setForm({ ...form, meetingUrl: event.target.value })} placeholder="https://meet.google.com/…" /></label>}
            <label><span className="label">Заметка <span className="font-normal text-ink-faint">· необязательно</span></span><textarea className="field min-h-10 resize-y" rows={1} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Что подготовить" /></label>
          </div>
        </div>}
      </Modal>

      <Modal
        open={Boolean(eventToDelete)}
        onClose={() => setEventToDelete(null)}
        title="Удалить созвон из календаря?"
        subtitle={eventToDelete ? `${eventToDelete.companyName} · ${eventToDelete.vacancyTitle}` : ''}
        footer={<>
          <button type="button" className="btn-ghost" onClick={() => setEventToDelete(null)}>Отмена</button>
          <button
            type="button"
            className="btn-danger"
            disabled={!eventToDelete || busy === `delete:${eventToDelete.id}`}
            onClick={() => eventToDelete && void confirmRemoveEvent(eventToDelete)}
          >
            <Trash2 size={14} /> {busy.startsWith('delete:') ? 'Удаляю…' : 'Удалить'}
          </button>
        </>}
      >
        <p className="text-sm leading-relaxed text-ink-muted">
          Календарная карточка и её подытог исчезнут. Сама запись разговора останется в «Истории», чтобы случайно не потерять транскрипт.
        </p>
      </Modal>
    </div>
  );
}
