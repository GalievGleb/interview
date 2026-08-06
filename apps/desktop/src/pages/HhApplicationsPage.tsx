import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Check, ChevronDown, Clock3, ExternalLink, FileText, Loader2, Mail, MessageCircle, RefreshCw, Search, Send } from 'lucide-react';
import AvailabilityEditor, { formatAvailabilitySummary } from '../components/interview/AvailabilityEditor';
import type { HhAssistantConfig, HhAssistantState, HhChatState, HhQueueItem, InterviewCalendarSettings, InterviewCalendarState } from '../types/electron';

const EMPTY_CONFIG: HhAssistantConfig = {
  platform: 'hh',
  query: '', area: '113', experience: '', employment: 'full', schedule: '', salaryFrom: null,
  onlyWithSalary: false, excludedKeywords: [], excludedEmployers: [], maxQueueSize: 30, maxPages: 2,
  coverLetterTemplate: 'Здравствуйте! Меня заинтересовала вакансия «{vacancy}» в {company}. Буду рад обсудить мой релевантный опыт и задачи команды на интервью.',
  autoSend: true, resumeTitleContains: '', resumeTitles: [], delayBetweenSec: 5, dailyLimit: 200,
  autoRunDaily: false, autoRunHour: 10,
  linkedinLocation: '', linkedinEasyApplyOnly: true, avitoCity: 'all',
};

const PLATFORMS = [
  { id: 'hh' as const, label: 'HH.ru', hint: 'Почта + код, поиск и автоотклики' },
  { id: 'linkedin' as const, label: 'LinkedIn', hint: 'Jobs и Easy Apply' },
  { id: 'avito' as const, label: 'Avito Работа', hint: 'Поиск вакансий и ручное подтверждение' },
];

const splitList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
const sentToday = (queue: HhQueueItem[]) => {
  const today = new Date().toDateString();
  return queue.filter((item) => item.status === 'sent' && item.sentAt && new Date(item.sentAt).toDateString() === today).length;
};

const queueStatus = (item: HhQueueItem) => {
  if (item.status === 'sent') return { label: 'Отправлено', tone: 'bg-emerald-500/10 text-emerald-300' };
  if (item.status === 'skipped') return { label: 'Пропущено', tone: 'bg-amber-500/10 text-amber-200' };
  if (item.status === 'prepared') return { label: 'Письмо готово', tone: 'bg-sky-500/10 text-sky-200' };
  if (item.status === 'opened') return { label: 'Открыто', tone: 'bg-surface-elevated text-ink-muted' };
  return { label: 'В очереди', tone: 'bg-surface-elevated text-ink-muted' };
};

export default function HhApplicationsPage() {
  const assistant = window.electronAPI?.hhAssistant;
  const chat = window.electronAPI?.hhChat;
  const calendar = window.electronAPI?.interviewCalendar;
  const navigate = useNavigate();
  const [state, setState] = useState<HhAssistantState | null>(null);
  const [draft, setDraft] = useState(EMPTY_CONFIG);
  const [excludedKeywords, setExcludedKeywords] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [resumes, setResumes] = useState<Array<{ id: string; title: string; url: string }>>([]);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeLoadError, setResumeLoadError] = useState('');
  const [chatState, setChatState] = useState<HhChatState | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [calendarState, setCalendarState] = useState<InterviewCalendarState | null>(null);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);

  useEffect(() => {
    if (!assistant) return;
    let active = true;
    void assistant.getState().then((next) => {
      if (!active) return;
      setState(next); setDraft(next.config);
      setExcludedKeywords(next.config.excludedKeywords.join(', '));
    });
    const unsubscribe = assistant.onState((next) => { if (active) setState(next); });
    return () => { active = false; unsubscribe(); };
  }, [assistant]);

  useEffect(() => {
    if (!chat) return;
    let active = true;
    const refresh = () => {
      void chat.getState().then((next) => { if (active) setChatState(next); });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [chat]);

  useEffect(() => {
    if (!calendar) return;
    let active = true;
    void calendar.getState().then((next) => { if (active) setCalendarState(next); });
    const unsubscribe = calendar.onState((next) => { if (active) setCalendarState(next); });
    return () => { active = false; unsubscribe(); };
  }, [calendar]);

  const config = (): HhAssistantConfig => ({
    ...draft, excludedKeywords: splitList(excludedKeywords),
  });
  const run = async (key: string, action: () => Promise<HhAssistantState>) => {
    setBusy(key);
    try { setState(await action()); } finally { setBusy(''); }
  };
  const saveAutomation = async () => {
    if (!assistant) return;
    await run('save', async () => {
      const isHh = draft.platform === 'hh';
      const next = await assistant.saveConfig({ ...config(), autoRunDaily: isHh });
      setDraft(next.config);
      if (isHh) await assistant.setDailySchedule(true);
      const scanned = await assistant.scan(draft.platform);
      return isHh ? assistant.applyAll() : scanned;
    });
  };
  const activeQueue = useMemo(() => (state?.queue ?? []).filter((item) => item.platform === draft.platform), [state?.queue, draft.platform]);
  const platformMatches = state?.config.platform === draft.platform;
  const connected = Boolean(state?.browserOpen && platformMatches && !state.loginRequired);
  const hhConnected = draft.platform === 'hh' && connected;

  const loadResumes = useCallback(async () => {
    if (!assistant || !hhConnected) {
      setResumes([]);
      setResumeLoadError('');
      setResumeLoading(false);
      return;
    }
    setResumeLoading(true);
    setResumeLoadError('');
    try {
      setResumes(await assistant.getResumes());
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      setResumeLoadError(
        rawMessage.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '') ||
          'Не удалось загрузить резюме из HH.',
      );
    } finally {
      setResumeLoading(false);
    }
  }, [assistant, hhConnected]);

  useEffect(() => { void loadResumes(); }, [loadResumes]);

  const requestLoginCode = async () => {
    if (!assistant) return;
    setBusy('auth');
    setAuthMessage('');
    try {
      const result = await assistant.requestLoginCode(email);
      setAuthMessage(result.message);
      setCodeRequested(result.ok);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Не удалось отправить код.');
    } finally {
      setBusy('');
    }
  };

  const confirmLoginCode = async () => {
    if (!assistant) return;
    setBusy('auth');
    setAuthMessage('');
    try {
      const result = await assistant.confirmLoginCode(code);
      setAuthMessage(result.message);
      if (result.ok) {
        setState(await assistant.getState());
        setCode('');
      }
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Не удалось подтвердить код.');
    } finally {
      setBusy('');
    }
  };

  const toggleChat = async () => {
    if (!chat) return;
    if (!chatState?.enabled && !calendarState?.settings.availabilityConfigured) {
      setChatError('Укажите удобные дни и часы — после сохранения автоответы включатся автоматически.');
      setAvailabilityOpen(true);
      return;
    }
    setChatBusy(true);
    setChatError('');
    try {
      setChatState(await chat.setEnabled(!chatState?.enabled));
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Не удалось изменить режим ответов HR.');
    } finally {
      setChatBusy(false);
    }
  };

  const saveAvailabilityAndEnableChat = async (settings: Partial<InterviewCalendarSettings>) => {
    if (!calendar || !chat) throw new Error('Календарь или ответы HR недоступны.');
    setChatBusy(true);
    setChatError('');
    try {
      const next = await calendar.saveSettings(settings);
      setCalendarState(next);
      if (!chatState?.enabled) setChatState(await chat.setEnabled(true));
      setAvailabilityOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось сохранить удобное время.';
      setChatError(message);
      throw error;
    } finally {
      setChatBusy(false);
    }
  };

  const pollChat = async () => {
    if (!chat) return;
    setChatBusy(true);
    setChatError('');
    try {
      setChatState(await chat.pollNow());
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Не удалось проверить сообщения HR.');
    } finally {
      setChatBusy(false);
    }
  };

  if (!assistant) return <div className="panel-card mx-auto max-w-xl p-8 text-center"><h1 className="page-title">Автоотклики доступны в desktop-приложении</h1></div>;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-5 overflow-y-auto pb-8">
      <header>
        <h1 className="page-title text-2xl">Автоотклики</h1>
        <p className="page-subtitle mt-1">Одна очередь для HH.ru, LinkedIn Jobs и Avito Работа.</p>
      </header>

      <section className="grid shrink-0 gap-3 md:grid-cols-3" aria-label="Площадки для откликов">
        {PLATFORMS.map((item) => <button key={item.id} type="button" onClick={() => setDraft({ ...draft, platform: item.id })} className={`rounded-xl border p-4 text-left transition-colors ${draft.platform === item.id ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-surface-border bg-surface-light hover:bg-surface-hover'}`}>
          <div className="flex items-center justify-between gap-3"><b className="text-sm text-ink">{item.label}</b><span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300">Работает</span></div>
          <p className="mt-2 text-xs text-ink-faint">{item.hint}</p>
        </button>)}
      </section>

      {draft.platform === 'hh' ? <section className="panel-card shrink-0 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`grid h-10 w-10 place-items-center rounded-full ${hhConnected ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}><Mail size={19} /></div>
            <div><h2 className="panel-title">{hhConnected ? 'HH подключён' : 'Подключите аккаунт HH'}</h2><p className="text-xs text-ink-faint">{hhConnected ? 'Сессия сохранена на этом устройстве' : 'Введите почту, которая привязана к вашему аккаунту HH'}</p></div>
          </div>
          {hhConnected && <span className="flex items-center gap-1.5 text-sm text-emerald-300"><Check size={15} /> Готово</span>}
        </div>
        {!hhConnected && <div className="mt-4 flex max-w-xl flex-wrap gap-2">
          {!codeRequested ? <>
            <input className="field min-w-[240px] flex-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Почта, привязанная к HH" />
            <button className="btn-primary" disabled={busy === 'auth' || !email.trim()} onClick={() => void requestLoginCode()}>{busy === 'auth' && <Loader2 className="animate-spin" size={15} />}Получить код от HH</button>
          </> : <>
            <input className="field min-w-[200px] flex-1" inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Код из письма" />
            <button className="btn-primary" disabled={busy === 'auth' || !code.trim()} onClick={() => void confirmLoginCode()}>{busy === 'auth' && <Loader2 className="animate-spin" size={15} />}Подключить</button>
            <button className="btn-ghost" onClick={() => { setCodeRequested(false); setCode(''); }}>Изменить почту</button>
          </>}
        </div>}
        {!hhConnected && <p className="mt-3 text-xs text-ink-faint">SkillCue подключит HH в фоне: отдельное окно не откроется. Мы не запрашиваем пароль и сохраняем сессию только на этом устройстве.</p>}
        {authMessage && <p className="mt-2 text-xs text-ink-muted">{authMessage}</p>}
      </section> : <section className="panel-card shrink-0 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 className="panel-title">Подключите {PLATFORMS.find((item) => item.id === draft.platform)?.label}</h2><p className="text-xs text-ink-faint">Вход выполняется вручную в обычном Chrome; сессия остаётся только на этом устройстве.</p></div>
          <button className="btn-primary" disabled={busy === 'browser'} onClick={() => void run('browser', () => assistant.openBrowser(draft.platform))}>{busy === 'browser' ? <Loader2 className="animate-spin" size={15} /> : <ExternalLink size={15} />}Открыть площадку</button>
        </div>
        {state?.message && <p className="mt-3 text-xs text-ink-muted">{state.message}</p>}
      </section>}

      {!connected ? (
        <div className="rounded-xl border border-dashed border-surface-border px-6 py-10 text-center text-sm text-ink-faint">
          Сначала откройте выбранную площадку и войдите в аккаунт. После этого запустите поиск.
        </div>
      ) : <>

      {draft.platform === 'hh' && <section className="panel-card shrink-0 overflow-hidden">
        <div className="panel-header flex-wrap gap-3"><div><h2 className="panel-title">1. Выберите резюме</h2><p className="mt-0.5 text-xs text-ink-faint">Можно выбрать несколько — SkillCue подберёт наиболее подходящее к вакансии</p></div><button type="button" className="btn-ghost ml-auto" disabled={resumeLoading} onClick={() => void loadResumes()}>{resumeLoading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}Обновить</button></div>
        <div className="grid gap-2 p-5 md:grid-cols-2">
          {resumeLoadError && <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-sm text-amber-200 md:col-span-2"><p>{resumeLoadError}</p><button type="button" className="btn-ghost mt-2" disabled={resumeLoading} onClick={() => void loadResumes()}><RefreshCw size={14} />Повторить</button></div>}
          {resumeLoading && resumes.length === 0 && <p className="flex items-center gap-2 text-sm text-ink-faint md:col-span-2"><Loader2 className="animate-spin" size={15} />Загружаю резюме из HH…</p>}
          {!resumeLoading && !resumeLoadError && resumes.length === 0 && <p className="text-sm text-ink-faint md:col-span-2">HH открыл список, но не показал опубликованных резюме.</p>}
          {resumes.map((resume) => {
            const checked = draft.resumeTitles.includes(resume.title);
            return <label key={resume.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${checked ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-surface-border'}`}><input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={checked} onChange={() => setDraft({ ...draft, resumeTitles: checked ? draft.resumeTitles.filter((title) => title !== resume.title) : [...draft.resumeTitles, resume.title], resumeTitleContains: '' })} /><FileText size={17} className="text-ink-muted" /><span className="text-sm text-ink">{resume.title}</span></label>;
          })}
        </div>
      </section>}

      <section className="panel-card overflow-hidden">
        <div className="panel-header"><div><h2 className="panel-title">2. Что искать</h2><p className="mt-0.5 text-xs text-ink-faint">Настройте поисковую выдачу</p></div></div>
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <label className="block md:col-span-2"><span className="label">Должность</span><input className="field" value={draft.query} onChange={(e) => setDraft({ ...draft, query: e.target.value })} placeholder="Например, QA Automation Engineer" /></label>
          {draft.platform === 'hh' ? <>
            <label className="block"><span className="label">Регион</span><select className="field" value={draft.area} onChange={(e) => setDraft({ ...draft, area: e.target.value })}><option value="113">Вся Россия</option><option value="1">Москва</option><option value="2">Санкт-Петербург</option></select></label>
            <label className="block"><span className="label">Опыт</span><select className="field" value={draft.experience} onChange={(e) => setDraft({ ...draft, experience: e.target.value })}><option value="">Любой</option><option value="noExperience">Без опыта</option><option value="between1And3">1–3 года</option><option value="between3And6">3–6 лет</option><option value="moreThan6">Более 6 лет</option></select></label>
          </> : draft.platform === 'linkedin' ? <>
            <label className="block"><span className="label">Локация</span><input className="field" value={draft.linkedinLocation} onChange={(e) => setDraft({ ...draft, linkedinLocation: e.target.value })} placeholder="Russia или Remote" /></label>
            <label className="flex items-center gap-2 text-sm text-ink-muted"><input type="checkbox" checked={draft.linkedinEasyApplyOnly} onChange={(e) => setDraft({ ...draft, linkedinEasyApplyOnly: e.target.checked })} />Только Easy Apply</label>
          </> : <label className="block"><span className="label">Город в URL Avito</span><input className="field" value={draft.avitoCity} onChange={(e) => setDraft({ ...draft, avitoCity: e.target.value })} placeholder="all, moskva, krasnoyarsk" /></label>}
          <label className="block"><span className="label">Формат работы</span><select className="field" value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}><option value="">Любой</option><option value="remote">Удалённо</option><option value="fullDay">Полный день</option><option value="flexible">Гибкий график</option></select></label>
          <label className="block"><span className="label">Зарплата от</span><input className="field" type="number" min={0} step={10000} value={draft.salaryFrom ?? ''} onChange={(e) => setDraft({ ...draft, salaryFrom: e.target.value ? Number(e.target.value) : null })} placeholder="150 000" /></label>
          <button type="button" className="flex items-center gap-2 text-sm text-ink-muted md:col-span-2" onClick={() => setShowAdvanced(!showAdvanced)}><ChevronDown className={showAdvanced ? 'rotate-180' : ''} size={16} />Дополнительные фильтры</button>
          {showAdvanced && <div className="grid gap-4 md:col-span-2 md:grid-cols-2">
            <label className="block"><span className="label">Исключить слова</span><input className="field" value={excludedKeywords} onChange={(e) => setExcludedKeywords(e.target.value)} placeholder="стажёр, продажи" /></label>
            <label className="block"><span className="label">Исключить работодателей</span><input className="field" value={draft.excludedEmployers.join(', ')} onChange={(e) => setDraft({ ...draft, excludedEmployers: splitList(e.target.value) })} placeholder="Название компании" /></label>
          </div>}
        </div>
      </section>

      <section className="panel-card shrink-0 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span><b className="block text-sm text-ink">3. Запустить поиск</b><span className="text-xs text-ink-faint">{draft.platform === 'hh' ? 'Перед каждым откликом AI сопоставит резюме с вакансией и напишет отдельное письмо' : 'Найденное попадёт в отдельную очередь выбранной площадки'}</span></span>
          {draft.platform === 'hh' && <label className="flex items-center gap-2 text-sm text-ink-muted"><Clock3 size={16} />Ежедневно в <select className="field w-24" value={draft.autoRunHour} onChange={(e) => setDraft({ ...draft, autoRunHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label>}
          <button className="btn-primary" disabled={busy !== '' || !draft.query.trim() || (draft.platform === 'hh' && draft.resumeTitles.length === 0)} onClick={() => void saveAutomation()}>{busy === 'save' ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}{draft.platform === 'hh' ? 'Найти и запустить автоотклики' : 'Найти вакансии'}</button>
        </div>
      </section>

      <section className="panel-card flex min-h-[280px] shrink-0 flex-col overflow-hidden">
        <div className="panel-header flex-wrap gap-3"><div><h2 className="panel-title">Найденные вакансии</h2><p className="mt-0.5 text-xs text-ink-faint">Всего: {activeQueue.length} · сегодня отправлено: {sentToday(state?.queue ?? [])}</p></div>{draft.autoRunDaily && <span className="ml-auto flex items-center gap-1.5 text-xs text-emerald-300"><span className="sc-dot sc-dot--live" /> Автоотклики включены</span>}</div>
        {state?.message && <div className="border-b border-surface-border bg-surface-light px-5 py-3 text-sm text-ink-muted" role="status">{state.message}</div>}
        <div className="min-h-[320px] max-h-[60vh] flex-1 divide-y divide-surface-border overflow-y-auto">
          {activeQueue.length === 0 ? <div className="flex min-h-[220px] items-center justify-center p-8 text-center text-sm text-ink-faint"><span><Send className="mx-auto mb-2" size={22} />Здесь появятся все найденные вакансии</span></div> : activeQueue.map((item) => {
            const status = queueStatus(item);
            return <div key={item.key} className="flex items-start gap-3 px-5 py-3"><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium text-ink">{item.title}</p><p className="break-words text-xs text-ink-faint">{item.company}{item.salary ? ` · ${item.salary}` : ''}</p>{item.reason && <p className="mt-1 break-words text-xs text-ink-muted">{item.reason}</p>}</div><span className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${status.tone}`}>{status.label}</span><button className="btn-ghost shrink-0" onClick={() => void run('open', () => assistant.openVacancy(item.key))}><ExternalLink size={14} />Открыть</button></div>;
          })}
        </div>
      </section>

      {draft.platform === 'hh' && chat && <section className="panel-card shrink-0 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-full bg-sky-500/10 text-sky-200"><MessageCircle size={19} /></div><div><h2 className="panel-title">Ответы на сообщения HR</h2><p className="text-xs text-ink-faint">Проверяет активные диалоги и отвечает только если последнее сообщение пришло от работодателя</p></div></div>
          <div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost" onClick={() => navigate('/calendar')}><CalendarDays size={14} />Календарь</button><button type="button" className="btn-ghost" disabled={chatBusy || chatState?.polling} onClick={() => void pollChat()}>{chatBusy || chatState?.polling ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}Проверить сейчас</button><button type="button" className="btn-primary" disabled={chatBusy} onClick={() => void toggleChat()}>{chatState?.enabled ? 'Выключить автоответы' : 'Включить автоответы'}</button></div>
        </div>
        <div className={`mt-4 rounded-xl border p-4 ${calendarState?.settings.availabilityConfigured ? 'border-emerald-500/20 bg-emerald-500/[0.04]' : 'border-amber-400/25 bg-amber-400/[0.06]'}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <CalendarDays className={calendarState?.settings.availabilityConfigured ? 'text-emerald-300' : 'text-amber-200'} size={18} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">Когда можно назначать созвоны</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {calendarState
                    ? formatAvailabilitySummary(calendarState.settings)
                    : 'Загружаю доступность…'}
                </p>
              </div>
            </div>
            {calendarState?.settings.availabilityConfigured && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => setAvailabilityOpen((open) => !open)}>
                {availabilityOpen ? 'Свернуть' : 'Изменить'}
              </button>
            )}
          </div>
          {calendarState && (availabilityOpen || !calendarState.settings.availabilityConfigured) && (
            <div className="mt-4 border-t border-surface-border pt-4">
              <p className="mb-3 text-xs text-ink-muted">Бот примет подходящий вариант HR, а при несовпадении предложит три ближайших свободных слота.</p>
              <AvailabilityEditor
                compact
                settings={calendarState.settings}
                onSave={saveAvailabilityAndEnableChat}
                submitLabel={chatState?.enabled ? 'Сохранить' : 'Сохранить и включить автоответы'}
              />
            </div>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-muted"><span>Активных диалогов: {chatState?.activeNegotiations ?? 0}</span><span>Входящих к ответу: {chatState?.unreadMessages ?? 0}</span><span>Ответов сегодня: {chatState?.repliesToday ?? 0}</span>{chatState?.lastPollAt && <span>Проверено: {new Date(chatState.lastPollAt).toLocaleTimeString()}</span>}</div>
        {(chatError || chatState?.error) && <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-200">{chatError || chatState?.error}</p>}
      </section>}
      </>}
    </div>
  );
}
