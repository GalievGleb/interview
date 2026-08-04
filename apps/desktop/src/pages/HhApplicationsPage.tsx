import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Clock3, Loader2, Mail, Play, Search, Send, StopCircle } from 'lucide-react';
import type { HhAssistantConfig, HhAssistantState, HhQueueItem } from '../types/electron';

const EMPTY_CONFIG: HhAssistantConfig = {
  query: '', area: '113', experience: '', employment: 'full', schedule: '', salaryFrom: null,
  onlyWithSalary: false, excludedKeywords: [], excludedEmployers: [], maxQueueSize: 30, maxPages: 2,
  coverLetterTemplate: 'Здравствуйте! Меня заинтересовала вакансия «{vacancy}» в {company}. Буду рад обсудить мой релевантный опыт и задачи команды на интервью.',
  autoSend: true, resumeTitleContains: '', delayBetweenSec: 5, dailyLimit: 200,
  autoRunDaily: false, autoRunHour: 10,
};

const splitList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
const sentToday = (queue: HhQueueItem[]) => {
  const today = new Date().toDateString();
  return queue.filter((item) => item.status === 'sent' && item.sentAt && new Date(item.sentAt).toDateString() === today).length;
};

export default function HhApplicationsPage() {
  const assistant = window.electronAPI?.hhAssistant;
  const [state, setState] = useState<HhAssistantState | null>(null);
  const [draft, setDraft] = useState(EMPTY_CONFIG);
  const [excludedKeywords, setExcludedKeywords] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

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
      const next = await assistant.saveConfig(config());
      return assistant.setDailySchedule(next.config.autoRunDaily);
    });
  };
  const activeQueue = useMemo(() => (state?.queue ?? []).filter((item) => item.status !== 'skipped').slice(0, 8), [state?.queue]);
  const hhConnected = Boolean(state?.browserOpen && !state.loginRequired);

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

  if (!assistant) return <div className="panel-card mx-auto max-w-xl p-8 text-center"><h1 className="page-title">Автоотклики доступны в desktop-приложении</h1></div>;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 pb-8">
      <header>
        <h1 className="page-title text-2xl">Автоотклики</h1>
        <p className="page-subtitle mt-1">Один раз настройте поиск — SkillCue каждый день найдёт вакансии, подготовит персональное письмо и откликнется.</p>
      </header>

      <section className="panel-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`grid h-10 w-10 place-items-center rounded-full ${hhConnected ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}><Mail size={19} /></div>
            <div><h2 className="panel-title">{hhConnected ? 'HH подключён' : 'Подключите HH'}</h2><p className="text-xs text-ink-faint">{hhConnected ? 'Сессия сохранена на этом устройстве' : 'Без пароля — только почта и код'}</p></div>
          </div>
          {hhConnected && <span className="flex items-center gap-1.5 text-sm text-emerald-300"><Check size={15} /> Готово</span>}
        </div>
        {!hhConnected && <div className="mt-4 flex max-w-xl flex-wrap gap-2">
          {!codeRequested ? <>
            <input className="field min-w-[240px] flex-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Почта от аккаунта HH" />
            <button className="btn-primary" disabled={busy === 'auth' || !email.trim()} onClick={() => void requestLoginCode()}>{busy === 'auth' && <Loader2 className="animate-spin" size={15} />}Получить код</button>
          </> : <>
            <input className="field min-w-[200px] flex-1" inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Код из письма" />
            <button className="btn-primary" disabled={busy === 'auth' || !code.trim()} onClick={() => void confirmLoginCode()}>{busy === 'auth' && <Loader2 className="animate-spin" size={15} />}Подключить</button>
            <button className="btn-ghost" onClick={() => { setCodeRequested(false); setCode(''); }}>Изменить почту</button>
          </>}
        </div>}
        {authMessage && <p className="mt-2 text-xs text-ink-muted">{authMessage}</p>}
      </section>

      <section className="panel-card overflow-hidden">
        <div className="panel-header"><div><h2 className="panel-title">Что искать</h2><p className="mt-0.5 text-xs text-ink-faint">Основные фильтры</p></div></div>
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <label className="block md:col-span-2"><span className="label">Должность</span><input className="field" value={draft.query} onChange={(e) => setDraft({ ...draft, query: e.target.value })} placeholder="Например, QA Automation Engineer" /></label>
          <label className="block"><span className="label">Регион</span><select className="field" value={draft.area} onChange={(e) => setDraft({ ...draft, area: e.target.value })}><option value="113">Вся Россия</option><option value="1">Москва</option><option value="2">Санкт-Петербург</option></select></label>
          <label className="block"><span className="label">Опыт</span><select className="field" value={draft.experience} onChange={(e) => setDraft({ ...draft, experience: e.target.value })}><option value="">Любой</option><option value="noExperience">Без опыта</option><option value="between1And3">1–3 года</option><option value="between3And6">3–6 лет</option><option value="moreThan6">Более 6 лет</option></select></label>
          <label className="block"><span className="label">Формат работы</span><select className="field" value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}><option value="">Любой</option><option value="remote">Удалённо</option><option value="fullDay">Полный день</option><option value="flexible">Гибкий график</option></select></label>
          <label className="block"><span className="label">Зарплата от</span><input className="field" type="number" min={0} step={10000} value={draft.salaryFrom ?? ''} onChange={(e) => setDraft({ ...draft, salaryFrom: e.target.value ? Number(e.target.value) : null })} placeholder="150 000" /></label>
          <button type="button" className="flex items-center gap-2 text-sm text-ink-muted md:col-span-2" onClick={() => setShowAdvanced(!showAdvanced)}><ChevronDown className={showAdvanced ? 'rotate-180' : ''} size={16} />Дополнительные фильтры</button>
          {showAdvanced && <div className="grid gap-4 md:col-span-2 md:grid-cols-2">
            <label className="block"><span className="label">Исключить слова</span><input className="field" value={excludedKeywords} onChange={(e) => setExcludedKeywords(e.target.value)} placeholder="стажёр, продажи" /></label>
            <label className="block"><span className="label">Выбрать резюме</span><input className="field" value={draft.resumeTitleContains} onChange={(e) => setDraft({ ...draft, resumeTitleContains: e.target.value })} placeholder="Часть названия резюме" /></label>
          </div>}
        </div>
      </section>

      <section className="panel-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <label className="flex cursor-pointer items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-emerald-500" checked={draft.autoRunDaily} onChange={(e) => setDraft({ ...draft, autoRunDaily: e.target.checked })} /><span><b className="block text-sm text-ink">Запускать каждый день</b><span className="text-xs text-ink-faint">Найти свежие вакансии и отправить отклики</span></span></label>
          <label className="flex items-center gap-2 text-sm text-ink-muted"><Clock3 size={16} />В <select className="field w-24" value={draft.autoRunHour} onChange={(e) => setDraft({ ...draft, autoRunHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label>
          <button className="btn-primary" disabled={busy !== '' || !draft.query.trim()} onClick={() => void saveAutomation()}>{busy === 'save' ? <Loader2 className="animate-spin" size={16} /> : <Check size={16} />}Сохранить автоотклики</button>
        </div>
      </section>

      <section className="panel-card overflow-hidden">
        <div className="panel-header flex-wrap gap-3"><div><h2 className="panel-title">Последние отклики</h2><p className="mt-0.5 text-xs text-ink-faint">Сегодня отправлено: {sentToday(state?.queue ?? [])}</p></div><div className="ml-auto flex gap-2"><button className="btn-secondary btn-sm" disabled={busy !== '' || !draft.query.trim()} onClick={() => void run('scan', async () => { await assistant.saveConfig(config()); return assistant.scan(); })}><Search size={14} />Найти сейчас</button>{state?.applying ? <button className="btn-secondary btn-sm" onClick={() => void run('stop', () => assistant.stopApply())}><StopCircle size={14} />Остановить</button> : <button className="btn-primary btn-sm" disabled={busy !== '' || !draft.query.trim()} onClick={() => void run('apply', async () => { await assistant.saveConfig(config()); return assistant.applyAll(); })}><Play size={14} />Запустить</button>}</div></div>
        {state?.message && <div className="border-b border-surface-border bg-surface-light px-5 py-3 text-sm text-ink-muted" role="status">{state.message}</div>}
        <div className="divide-y divide-surface-border">
          {activeQueue.length === 0 ? <div className="p-8 text-center text-sm text-ink-faint"><Send className="mx-auto mb-2" size={22} />Здесь появятся найденные вакансии и отправленные отклики</div> : activeQueue.map((item) => <div key={item.id} className="flex items-center gap-3 px-5 py-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-ink">{item.title}</p><p className="truncate text-xs text-ink-faint">{item.company}{item.salary ? ` · ${item.salary}` : ''}</p></div><span className={`rounded-full px-2.5 py-1 text-xs ${item.status === 'sent' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-surface-elevated text-ink-muted'}`}>{item.status === 'sent' ? 'Отправлено' : item.status === 'prepared' ? 'Письмо готово' : 'В очереди'}</span></div>)}
        </div>
      </section>
    </div>
  );
}
