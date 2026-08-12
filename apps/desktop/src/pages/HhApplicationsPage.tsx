import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CalendarDays, Check, ChevronDown, Clock3, ExternalLink, FileText, Link2, Loader2, Mail, MessageCircle, RefreshCw, Search, Send, Settings2, Square, Trash2 } from 'lucide-react';
import AvailabilityEditor, { formatAvailabilitySummary } from '../components/interview/AvailabilityEditor';
import { countUnansweredHhScreeningQuestions, readHhScreeningDrafts, summarizePendingHhScreening } from '../lib/hhScreening';
import { pluralRu } from '../lib/pluralRu';
import type { HhAssistantConfig, HhAssistantState, HhChatState, HhQueueItem, InterviewCalendarSettings, InterviewCalendarState } from '../types/electron';

const EMPTY_CONFIG: HhAssistantConfig = {
  platform: 'hh',
  query: '', includeRelatedQueries: true, additionalQueries: [],
  area: '', experience: '', employment: '', schedule: 'remote', salaryFrom: null,
  onlyWithSalary: false, excludedKeywords: [], excludedEmployers: [], maxQueueSize: 500, maxPages: 20,
  coverLetterTemplate: 'Здравствуйте! Меня заинтересовала вакансия «{vacancy}» в {company}. Буду рад обсудить мой релевантный опыт и задачи команды на интервью.',
  autoSend: true, resumeTitleContains: '', resumeTitles: [], delayBetweenSec: 20, dailyLimit: 20,
  autoRunDaily: false, autoRunHour: 10,
  linkedinLocation: '', linkedinEasyApplyOnly: true, avitoCity: 'all',
};

const PLATFORMS = [
  { id: 'hh' as const, label: 'HH.ru', hint: 'Почта + код, поиск и автоотклики' },
  { id: 'linkedin' as const, label: 'LinkedIn', hint: 'Вакансии и Easy Apply' },
  { id: 'avito' as const, label: 'Avito Работа', hint: 'Поиск вакансий и ручное подтверждение' },
];

const splitList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
const errorMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '').trim() || fallback;
};
const sentToday = (queue: HhQueueItem[]) => {
  const today = new Date().toDateString();
  return queue.filter((item) => item.status === 'sent' && item.sentAt && new Date(item.sentAt).toDateString() === today).length;
};

const queueStatus = (item: HhQueueItem) => {
  if (item.status === 'sent') return { label: 'Отправлено', tone: 'bg-emerald-500/10 text-emerald-300' };
  if (item.status === 'already_applied') return { label: 'Уже откликались', tone: 'bg-sky-500/10 text-sky-200' };
  if (item.status === 'skipped') return { label: 'Пропущено', tone: 'bg-amber-500/10 text-amber-200' };
  if (item.status === 'needs_input') return { label: 'Нужен ваш ответ', tone: 'bg-amber-400/10 text-amber-100' };
  if (item.status === 'prepared') return { label: 'Письмо готово', tone: 'bg-sky-500/10 text-sky-200' };
  if (item.status === 'opened') return { label: 'Открыто', tone: 'bg-surface-elevated text-ink-muted' };
  return { label: 'В очереди', tone: 'bg-surface-elevated text-ink-muted' };
};

const runTriggerLabel = (trigger: 'manual' | 'schedule' | 'resume' | 'direct_link') => {
  if (trigger === 'schedule') return 'По расписанию';
  if (trigger === 'resume') return 'Продолжение очереди';
  if (trigger === 'direct_link') return 'По ссылке';
  return 'Вручную';
};

const runStatusMeta = (status: 'running' | 'completed' | 'attention' | 'failed' | 'stopped') => {
  if (status === 'running') return { label: 'Выполняется', tone: 'bg-sky-500/10 text-sky-200' };
  if (status === 'completed') return { label: 'Завершён', tone: 'bg-emerald-500/10 text-emerald-300' };
  if (status === 'attention') return { label: 'Нужно внимание', tone: 'bg-amber-500/10 text-amber-200' };
  if (status === 'stopped') return { label: 'Остановлен', tone: 'bg-surface-elevated text-ink-muted' };
  return { label: 'Ошибка', tone: 'bg-red-500/10 text-red-300' };
};

const chatReplySourceLabel = (source: HhChatState['replyHistory'][number]['source']) => {
  if (source === 'saved_fact') return 'По сохранённому ответу';
  if (source === 'resume_fact') return 'Из выбранного резюме';
  if (source === 'scheduling') return 'По календарю';
  if (source === 'user_confirmed') return 'Подтверждено вами';
  if (source === 'recovered') return 'Найдено в HH';
  return 'Автоответ';
};

const chatDecisionSuggestedAnswer = (kind: HhChatState['pendingDecisions'][number]['kind']) => {
  if (kind === 'contract') {
    return 'Да, рассматриваю оформление по ИП или как самозанятый на испытательный срок. Готов обсудить детали договора и порядок оплаты.';
  }
  return '';
};

export default function HhApplicationsPage() {
  const assistant = window.electronAPI?.hhAssistant;
  const chat = window.electronAPI?.hhChat;
  const calendar = window.electronAPI?.interviewCalendar;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<HhAssistantState | null>(null);
  const [draft, setDraft] = useState(EMPTY_CONFIG);
  const [excludedKeywords, setExcludedKeywords] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
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
  const [chatDecisionDrafts, setChatDecisionDrafts] = useState<Record<string, string>>({});
  const [selectedConversationKey, setSelectedConversationKey] = useState('');
  const [hhRestoreTimedOut, setHhRestoreTimedOut] = useState(false);
  const [calendarState, setCalendarState] = useState<InterviewCalendarState | null>(null);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [automationError, setAutomationError] = useState('');
  const [showSearchRequirement, setShowSearchRequirement] = useState(false);
  const [vacancyUrl, setVacancyUrl] = useState('');
  const [vacancyUrlError, setVacancyUrlError] = useState('');
  const [directApplyConfirmed, setDirectApplyConfirmed] = useState(false);
  const [queueView, setQueueView] = useState<'active' | 'sent' | 'dialogs' | 'replies' | 'archive'>('active');
  const [conversationStage, setConversationStage] = useState<'all' | 'waiting' | 'bot' | 'hr'>('all');
  const [visibleLimit, setVisibleLimit] = useState(25);
  const [pageMode, setPageMode] = useState<'activity' | 'settings'>(
    () => searchParams.get('mode') === 'settings' ? 'settings' : 'activity',
  );

  useEffect(() => {
    if (!assistant) return;
    let active = true;
    void assistant.getState().then((next) => {
      if (!active) return;
      setState(next); setDraft(next.config);
      setExcludedKeywords(next.config.excludedKeywords.join(', '));
    }).catch((error) => {
      if (active) setAutomationError(errorMessage(error, 'Не удалось загрузить состояние откликов.'));
    });
    const unsubscribe = assistant.onState((next) => { if (active) setState(next); });
    return () => { active = false; unsubscribe(); };
  }, [assistant]);

  useEffect(() => {
    if (!chat) return;
    let active = true;
    const refresh = () => {
      void chat.getState().then((next) => {
        if (!active) return;
        setChatState(next);
      }).catch((error) => {
        if (active) setChatError(errorMessage(error, 'Не удалось загрузить состояние диалогов HR.'));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [chat]);

  useEffect(() => {
    if (!calendar) return;
    let active = true;
    void calendar.getState().then((next) => { if (active) setCalendarState(next); }).catch((error) => {
      if (active) setChatError(errorMessage(error, 'Не удалось загрузить доступность для созвонов.'));
    });
    const unsubscribe = calendar.onState((next) => { if (active) setCalendarState(next); });
    return () => { active = false; unsubscribe(); };
  }, [calendar]);

  useEffect(() => {
    setVisibleLimit(25);
  }, [conversationStage, draft.platform, queueView]);

  useEffect(() => {
    if (draft.platform !== 'hh' && (queueView === 'dialogs' || queueView === 'replies')) {
      setQueueView('active');
    }
  }, [draft.platform, queueView]);

  useEffect(() => {
    if (searchParams.get('focus') !== 'hr-decisions' || !chatState) return;
    setPageMode('activity');
    window.setTimeout(() => {
      document.getElementById('hh-hr-responses')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  }, [chatState, searchParams]);

  useEffect(() => {
    if (searchParams.get('mode') === 'settings') setPageMode('settings');
  }, [searchParams]);

  useEffect(() => {
    const requestedView = searchParams.get('view');
    if (!requestedView || !['active', 'sent', 'dialogs', 'replies', 'archive'].includes(requestedView)) return;
    setPageMode('activity');
    setQueueView(requestedView as typeof queueView);
  }, [searchParams]);

  useEffect(() => {
    const requestedUrl = searchParams.get('vacancyUrl')?.trim() ?? '';
    if (!requestedUrl) return;
    setVacancyUrl(requestedUrl);
    setPageMode('activity');
  }, [searchParams]);

  useEffect(() => {
    const requestedResumeTitle = searchParams.get('resumeTitle')?.trim() ?? '';
    if (!requestedResumeTitle || !resumes.some((resume) => resume.title === requestedResumeTitle)) return;
    setDraft((current) => current.resumeTitles[0] === requestedResumeTitle
      ? current
      : { ...current, resumeTitles: [requestedResumeTitle], resumeTitleContains: '' });
  }, [resumes, searchParams]);

  const config = (): HhAssistantConfig => ({
    ...draft, excludedKeywords: splitList(excludedKeywords),
  });
  const run = async (key: string, action: () => Promise<HhAssistantState>) => {
    setBusy(key);
    try {
      setState(await action());
    } catch (error) {
      setAutomationError(errorMessage(error, 'Действие с откликами не выполнено.'));
      throw error;
    } finally {
      setBusy('');
    }
  };
  const saveAutomation = async () => {
    if (!assistant) return;
    await run('save', async () => {
      const next = await assistant.saveConfig(config());
      setDraft(next.config);
      return assistant.runNow();
    });
  };
  const saveSettingsOnly = async () => {
    if (!assistant) return;
    setAutomationError('');
    try {
      await run('settings', async () => {
        const next = await assistant.saveConfig(config());
        setDraft(next.config);
        setExcludedKeywords(next.config.excludedKeywords.join(', '));
        return next;
      });
    } catch (error) {
      setAutomationError(errorMessage(error, 'Не удалось сохранить настройки откликов.'));
    }
  };
  const activeQueue = useMemo(() => (state?.queue ?? []).filter((item) => item.platform === draft.platform), [state?.queue, draft.platform]);
  const visibleQueue = useMemo(() => {
    if (queueView === 'active') return activeQueue.filter((item) =>
      item.status === 'new' || item.status === 'opened' || item.status === 'prepared' || item.status === 'needs_input');
    if (queueView === 'sent') return activeQueue.filter((item) =>
      item.status === 'sent' || item.status === 'already_applied');
    if (queueView === 'archive') return activeQueue.filter((item) => item.status === 'skipped');
    return [];
  }, [activeQueue, queueView]);
  const visibleConversations = useMemo(
    () => queueView === 'dialogs'
      ? (chatState?.conversations ?? []).filter((item) => conversationStage === 'all' || item.stage === conversationStage)
      : [],
    [chatState?.conversations, conversationStage, queueView],
  );
  const visibleReplyHistory = useMemo(
    () => [...(chatState?.replyHistory ?? [])].sort((left, right) =>
      new Date(right.sentAt ?? right.recordedAt).getTime() - new Date(left.sentAt ?? left.recordedAt).getTime()),
    [chatState?.replyHistory],
  );
  const shownQueue = visibleQueue.slice(0, visibleLimit);
  const shownConversations = visibleConversations.slice(0, visibleLimit);
  const shownReplyHistory = visibleReplyHistory.slice(0, visibleLimit);
  const visiblePanelCount = queueView === 'replies'
    ? visibleReplyHistory.length
    : queueView === 'dialogs'
      ? visibleConversations.length
      : visibleQueue.length;
  const platformRuns = useMemo(
    () => (state?.runHistory ?? []).filter((item) => item.platform === draft.platform),
    [draft.platform, state?.runHistory],
  );
  const activeRun = useMemo(
    () => platformRuns.find((item) => item.status === 'running') ?? null,
    [platformRuns],
  );
  const stoppingRun = Boolean(activeRun && (state?.stopRequested || busy === 'stop'));
  const featuredRun = activeRun ?? platformRuns[0] ?? null;
  const previousRuns = useMemo(
    () => platformRuns.filter((item) => item.id !== featuredRun?.id).slice(0, 5),
    [featuredRun?.id, platformRuns],
  );
  const applyPercent = state?.applyProgress && state.applyProgress.total > 0
    ? Math.round((state.applyProgress.done / state.applyProgress.total) * 100)
    : null;
  const screeningSummary = useMemo(() => summarizePendingHhScreening(activeQueue), [activeQueue]);
  const screeningDrafts = useMemo(() => readHhScreeningDrafts(), []);
  const pendingScreeningQuestions = countUnansweredHhScreeningQuestions(screeningSummary, screeningDrafts);
  const platformMatches = state?.config.platform === draft.platform;
  const connected = Boolean(state?.browserOpen && platformMatches && !state.loginRequired);
  const hhConnected = draft.platform === 'hh' && connected;
  const hhRestoreCandidate = Boolean(
    state && draft.platform === 'hh' && platformMatches && !state.browserOpen && !state.loginRequired,
  );
  const hhSessionUnchecked = hhRestoreCandidate && !hhRestoreTimedOut;
  const canLoadHhResumes = hhConnected || hhRestoreCandidate;

  useEffect(() => {
    if (!hhRestoreCandidate) {
      setHhRestoreTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setHhRestoreTimedOut(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [hhRestoreCandidate]);

  useEffect(() => {
    if (hhConnected) return;
    setChatError('');
  }, [hhConnected]);
  const searchLaunchBusy = busy === 'save' || Boolean(activeRun);
  const searchLaunchLabel = searchLaunchBusy
    ? stoppingRun
      ? 'Останавливаем…'
      : state?.applying
      ? 'Обрабатываем отклики…'
      : state?.phase === 'scanning'
        ? 'Ищем вакансии…'
        : 'Запускаем поиск…'
    : draft.platform === 'hh'
      ? state?.queuePaused
        ? 'Продолжить обработку очереди'
        : draft.autoSend
          ? 'Найти и отправить отклики'
          : 'Найти и добавить в очередь'
      : 'Найти вакансии сейчас';

  const loadResumes = useCallback(async () => {
    if (!assistant || !canLoadHhResumes) {
      setResumes([]);
      setResumeLoadError('');
      setResumeLoading(false);
      return;
    }
    setResumeLoading(true);
    setResumeLoadError('');
    try {
      const loaded = await assistant.getResumes();
      setResumes(loaded);
      setDraft((current) => {
        if (current.platform !== 'hh') return current;
        const availableTitles = new Set(loaded.map((resume) => resume.title));
        const selected = current.resumeTitles.find((title) => availableTitles.has(title));
        const resumeTitles = selected ? [selected] : loaded[0] ? [loaded[0].title] : [];
        if (
          resumeTitles.length === current.resumeTitles.length &&
          resumeTitles.every((title, index) => title === current.resumeTitles[index])
        ) return current;
        return { ...current, resumeTitles, resumeTitleContains: '' };
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      setResumeLoadError(
        rawMessage.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '') ||
          'Не удалось загрузить резюме из HH.',
      );
    } finally {
      setResumeLoading(false);
    }
  }, [assistant, canLoadHhResumes]);

  useEffect(() => { void loadResumes(); }, [loadResumes]);

  const startRequirement = useMemo(() => {
    if (hhSessionUnchecked) return 'Подождите, пока SkillCue проверит сохранённую сессию HH.';
    if (!connected) return `Подключите ${PLATFORMS.find((item) => item.id === draft.platform)?.label ?? 'площадку'}.`;
    if (draft.platform === 'hh') {
      if (resumeLoading) return 'Подождите, пока SkillCue загрузит резюме из HH.';
      if (resumeLoadError) return 'Не удалось загрузить резюме — нажмите «Повторить» в шаге 1.';
      if (resumes.length === 0) return 'HH не показал опубликованных резюме — обновите список в шаге 1.';
      if (draft.resumeTitles.length === 0) return 'Выберите хотя бы одно резюме в шаге 1.';
    }
    if (!draft.query.trim()) return 'Укажите должность или поисковый запрос в шаге 2.';
    return '';
  }, [connected, draft.platform, draft.query, draft.resumeTitles.length, hhSessionUnchecked, resumeLoadError, resumeLoading, resumes.length]);

  const focusMissingRequirement = () => {
    const missingConnection = !connected || hhSessionUnchecked;
    const missingResume = draft.platform === 'hh' && (
      resumeLoading || resumeLoadError || resumes.length === 0 || draft.resumeTitles.length === 0
    );
    setShowSearchRequirement(!missingConnection && !missingResume && !draft.query.trim());
    const targetId = missingConnection ? 'hh-platform-connection' : missingResume ? 'hh-resume-selection' : 'hh-search-query';
    setPageMode('settings');
    window.setTimeout(() => {
      const target = document.getElementById(targetId);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (target instanceof HTMLInputElement) target.focus({ preventScroll: true });
    }, 40);
  };

  const launchAutomation = async () => {
    if (startRequirement) {
      focusMissingRequirement();
      return;
    }
    setShowSearchRequirement(false);
    setAutomationError('');
    try {
      await saveAutomation();
    } catch (error) {
      setAutomationError(errorMessage(error, 'Не удалось запустить автоотклики.'));
    }
  };

  const stopAutomation = async () => {
    if (!assistant || !activeRun || stoppingRun) return;
    setAutomationError('');
    try {
      await run('stop', () => assistant.stopApply());
    } catch (error) {
      setAutomationError(errorMessage(error, 'Не удалось остановить текущий поиск.'));
    }
  };

  const saveSchedule = async () => {
    if (!assistant) return;
    if (draft.autoRunDaily && startRequirement) {
      focusMissingRequirement();
      return;
    }
    setAutomationError('');
    try {
      await run('schedule', async () => {
        const next = await assistant.saveConfig(config());
        setDraft(next.config);
        return next;
      });
    } catch (error) {
      setAutomationError(errorMessage(error, 'Не удалось сохранить расписание.'));
    }
  };

  const applyDirectVacancy = async () => {
    if (!assistant) return;
    const normalized = vacancyUrl.trim();
    if (!/^https:\/\/(?:[a-z0-9-]+\.)*hh\.ru\/(?:vacancy\/\d+|applicant\/vacancy_response\?[^#]*vacancyId=\d+)(?:[/?#&].*)?$/i.test(normalized)) {
      setVacancyUrlError('Вставьте ссылку на вакансию или форму отклика HH.');
      return;
    }
    if (!directApplyConfirmed) {
      setVacancyUrlError('Подтвердите, что хотите сразу отправить отклик без дополнительного разбора.');
      return;
    }
    if (draft.resumeTitles.length === 0) {
      setVacancyUrlError('Сначала выберите резюме в шаге 1.');
      document.getElementById('hh-resume-selection')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setVacancyUrlError('');
    try {
      await run('direct', async () => {
        const next = await assistant.saveConfig({
          resumeTitles: draft.resumeTitles,
          resumeTitleContains: '',
        });
        setDraft((current) => ({
          ...current,
          resumeTitles: next.config.resumeTitles,
          resumeTitleContains: '',
        }));
        return assistant.applyVacancyUrl(normalized);
      });
    } catch (error) {
      setVacancyUrlError(errorMessage(error, 'Не удалось проверить вакансию по ссылке.'));
    }
  };

  const prepareDirectVacancy = () => {
    const normalized = vacancyUrl.trim();
    if (!/^https:\/\/(?:[a-z0-9-]+\.)*hh\.ru\/(?:vacancy\/\d+|applicant\/vacancy_response\?[^#]*vacancyId=\d+)(?:[/?#&].*)?$/i.test(normalized)) {
      setVacancyUrlError('Вставьте ссылку на вакансию или форму отклика HH.');
      return;
    }
    const query = new URLSearchParams({ vacancyUrl: normalized, from: 'applications' });
    const selectedResumeTitle = draft.resumeTitles[0];
    if (selectedResumeTitle) query.set('resumeTitle', selectedResumeTitle);
    navigate(`/prepare?${query.toString()}`);
  };

  const prepareQueueItem = (item: HhQueueItem) => {
    const query = new URLSearchParams({ vacancyUrl: item.url, from: 'applications' });
    if (item.selectedResumeTitle) query.set('resumeTitle', item.selectedResumeTitle);
    navigate(`/prepare?${query.toString()}`);
  };

  const applyQueueItem = async (item: HhQueueItem) => {
    if (!assistant) return;
    const confirmed = window.confirm(
      `Отправить отклик на «${item.title}» в ${item.company}? SkillCue использует резюме «${item.selectedResumeTitle || draft.resumeTitles[0] || 'выбранное в настройках'}» и остановится, если понадобится ваш ответ.`,
    );
    if (!confirmed) return;
    setAutomationError('');
    try {
      await run(`apply:${item.key}`, () => assistant.applyOne(item.key));
    } catch (error) {
      setAutomationError(errorMessage(error, 'Не удалось отправить выбранный отклик.'));
    }
  };

  const collectAutomationDiagnostics = async () => {
    if (!window.electronAPI?.collectDiagnostics) return;
    setBusy('diagnostics');
    try {
      await window.electronAPI.collectDiagnostics([]);
    } catch (error) {
      setAutomationError(errorMessage(error, 'Не удалось собрать диагностику.'));
    } finally {
      setBusy('');
    }
  };

  const scheduleDirty = Boolean(state && (
    state.config.autoRunDaily !== draft.autoRunDaily ||
    state.config.autoRunHour !== draft.autoRunHour
  ));

  const requestLoginCode = async () => {
    if (!assistant) return;
    if (!email.trim()) {
      setAuthMessage('Введите почту, привязанную к аккаунту HH.');
      emailRef.current?.focus();
      return;
    }
    setBusy('auth');
    setAuthMessage('');
    try {
      const result = await assistant.requestLoginCode(email);
      setAuthMessage(result.message);
      setCodeRequested(result.ok);
    } catch (error) {
      setAuthMessage(errorMessage(error, 'Не удалось отправить код.'));
    } finally {
      setBusy('');
    }
  };

  const confirmLoginCode = async () => {
    if (!assistant) return;
    if (!code.trim()) {
      setAuthMessage('Введите код из письма HH.');
      codeRef.current?.focus();
      return;
    }
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
      setAuthMessage(errorMessage(error, 'Не удалось подтвердить код.'));
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
      setChatError(errorMessage(error, 'Не удалось изменить режим ответов HR.'));
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
      const message = errorMessage(error, 'Не удалось сохранить удобное время.');
      setChatError(message);
      throw error;
    } finally {
      setChatBusy(false);
    }
  };

  const pollChat = async () => {
    if (!chat) return;
    if (!hhConnected) {
      setPageMode('settings');
      return;
    }
    setChatBusy(true);
    setChatError('');
    try {
      setChatState(await chat.pollNow());
    } catch (error) {
      setChatError(errorMessage(error, 'Не удалось проверить сообщения HR.'));
    } finally {
      setChatBusy(false);
    }
  };

  const answerChatDecision = async (decisionId: string, remember: boolean) => {
    if (!chat) return;
    const decision = chatState?.pendingDecisions.find((item) => item.id === decisionId);
    const answer = (chatDecisionDrafts[decisionId] ?? (decision ? chatDecisionSuggestedAnswer(decision.kind) : '')).trim();
    if (!answer) {
      setChatError('Напишите, что ответить работодателю.');
      return;
    }
    setChatBusy(true);
    setChatError('');
    try {
      setChatState(await chat.answerDecision(decisionId, answer, remember));
      setChatDecisionDrafts((current) => {
        const next = { ...current };
        delete next[decisionId];
        return next;
      });
    } catch (error) {
      setChatError(errorMessage(error, 'Не удалось отправить ответ работодателю.'));
    } finally {
      setChatBusy(false);
    }
  };

  const forgetChatFact = async (factId: string) => {
    if (!chat) return;
    setChatBusy(true);
    try {
      setChatState(await chat.forgetFact(factId));
    } catch (error) {
      setChatError(errorMessage(error, 'Не удалось удалить сохранённое условие.'));
    } finally {
      setChatBusy(false);
    }
  };

  const revealReplyHistory = () => {
    setQueueView('replies');
    window.setTimeout(() => {
      document.getElementById('hh-conversations-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  const focusHrDecisions = () => {
    document.getElementById('hh-hr-responses')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const openChatSettings = () => {
    setPageMode('settings');
    window.setTimeout(() => {
      document.getElementById('hh-chat-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 40);
  };

  const pendingHrDecisions = hhConnected ? chatState?.pendingDecisions.length ?? 0 : 0;
  const rawChatPanelError = chatError || chatState?.error || '';
  const chatPanelError = rawChatPanelError.includes('Браузер HH не открыт') ? '' : rawChatPanelError;
  // Счётчик показывает реальные карточки, где человек должен принять решение:
  // одну на вакансию с вопросами плюс отдельные входящие решения HR.
  const pendingScreeningVacancyCount = screeningSummary.vacancies.length;
  const userActionCount = pendingScreeningVacancyCount + pendingHrDecisions;
  const todaySent = sentToday(activeQueue);
  const activeVacancyCount = activeQueue.filter((item) =>
    item.status === 'new' || item.status === 'opened' || item.status === 'prepared' || item.status === 'needs_input').length;
  const sentVacancyCount = activeQueue.filter((item) =>
    item.status === 'sent' || item.status === 'already_applied').length;
  const archivedVacancyCount = activeQueue.filter((item) => item.status === 'skipped').length;
  const conversationCount = chatState?.conversations.length ?? 0;
  const replyHistoryCount = chatState?.replyHistory.length ?? 0;
  const queuePanelMeta = queueView === 'active'
    ? { title: 'Вакансии в работе', detail: `В работе: ${activeVacancyCount} · Отправлено сегодня: ${todaySent}` }
    : queueView === 'sent'
      ? { title: 'Отправленные отклики', detail: `С откликом: ${sentVacancyCount}` }
      : queueView === 'dialogs'
        ? { title: 'Диалоги с работодателями', detail: `Диалогов: ${conversationCount}` }
        : queueView === 'replies'
          ? { title: 'Ответы SkillCue', detail: `Сохранённых ответов: ${replyHistoryCount}` }
          : { title: 'Пропущенные вакансии', detail: `Пропущено: ${archivedVacancyCount}` };
  const emptyQueueCopy: {
    title: string;
    detail: string;
    actionLabel?: string;
    action?: () => void;
  } = queueView === 'active'
    ? {
        title: 'Очередь в работе пуста',
        detail: 'Выберите площадку и направление — SkillCue соберёт подходящие вакансии.',
        actionLabel: 'Настроить поиск',
        action: () => setPageMode('settings'),
      }
    : queueView === 'sent'
      ? {
          title: 'Отправленных откликов пока нет',
          detail: 'После подтверждённой отправки вакансии появятся здесь.',
          actionLabel: 'Настроить поиск',
          action: () => setPageMode('settings'),
        }
      : queueView === 'dialogs'
        ? {
            title: 'Новых диалогов пока нет',
            detail: hhConnected ? 'Новые сообщения появятся здесь.' : 'Подключите HH, чтобы проверить новые сообщения.',
            actionLabel: hhConnected ? 'Проверить сообщения' : 'Подключить HH',
            action: hhConnected ? () => void pollChat() : () => setPageMode('settings'),
          }
        : queueView === 'replies'
          ? {
              title: 'Отправленных ответов пока нет',
              detail: (chatState?.repliesToday ?? 0) > 0
                ? 'Синхронизируйте диалоги HH, чтобы восстановить точные ответы.'
                : 'Здесь появятся вопросы HR и ответы, отправленные от вашего имени.',
              actionLabel: hhConnected ? 'Проверить сообщения' : 'Подключить HH',
              action: hhConnected ? () => void pollChat() : () => setPageMode('settings'),
            }
          : {
              title: 'Пропущенных вакансий нет',
              detail: 'Здесь останутся только вакансии, которые не потребовали дальнейших действий.',
            };
  const overview = pendingHrDecisions > 0
    ? {
        title: `HR ждёт ${pendingHrDecisions === 1 ? 'вашего решения' : `${pendingHrDecisions} ваших решений`}`,
        detail: 'SkillCue остановил только сообщения, где нельзя честно выбрать условия за вас.',
        label: 'Разобрать сообщение',
        action: focusHrDecisions,
        tone: 'attention',
      }
    : pendingScreeningVacancyCount > 0
      ? {
          title: pendingScreeningQuestions > 0
            ? `${pendingScreeningVacancyCount} ${pluralRu(pendingScreeningVacancyCount, 'отклик ждёт', 'отклика ждут', 'откликов ждут')} ваших ответов`
            : 'Ответы сохранены и готовы к отправке',
          detail: pendingScreeningQuestions === 0
            ? 'Откройте вопросы, проверьте ответы и продолжите отклики.'
            : screeningSummary.quotaLimitedCount > 0
            ? `${pendingScreeningQuestions} ${pluralRu(pendingScreeningQuestions, 'вопрос работодателя', 'вопроса работодателей', 'вопросов работодателей')}. Для ${screeningSummary.quotaLimitedCount} из них онлайн-ИИ достиг лимита.`
            : `${pendingScreeningQuestions} ${pluralRu(pendingScreeningQuestions, 'вопрос работодателя', 'вопроса работодателей', 'вопросов работодателей')}. Поиск и другие отклики продолжаются.`,
          label: 'Открыть все вопросы',
          action: () => navigate('/applications/hr-profile'),
          tone: 'attention',
        }
      : activeRun
        ? {
            title: stoppingRun ? 'Останавливаем поиск и отклики' : 'Поиск и отправка откликов идут',
            detail: applyPercent == null
              ? 'SkillCue последовательно проверяет найденные вакансии.'
              : `Выполнено ${applyPercent}% текущей очереди. Подробности доступны ниже.`,
            label: stoppingRun ? 'Останавливаем…' : 'Остановить',
            action: () => void stopAutomation(),
            tone: 'active',
          }
        : state?.queuePaused
          ? {
              title: 'Поиск и автоотклики остановлены',
              detail: 'Уже выполненные действия сохранены. Оставшаяся очередь продолжится только после нового запуска.',
              label: 'Продолжить поиск',
              action: () => void launchAutomation(),
              tone: 'paused',
            }
        : {
            title: startRequirement
              ? 'Нужно завершить настройку поиска'
              : todaySent > 0
                ? `Сегодня отправлено ${todaySent}`
                : 'Можно запускать следующий поиск',
            detail: startRequirement
              ? startRequirement
              : todaySent > 0
                ? 'Последний запуск завершён; результат и история доступны ниже.'
                : 'Параметры сохраняются — перед запуском достаточно проверить направление.',
            label: startRequirement ? 'Проверить настройки' : 'Запустить поиск',
            action: startRequirement ? () => setPageMode('settings') : () => void launchAutomation(),
            tone: 'ready',
          };

  if (!assistant) return <div className="panel-card mx-auto max-w-xl p-8 text-center"><h1 className="page-title">Автоотклики доступны в desktop-приложении</h1></div>;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 pb-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title text-2xl">Отклики</h1>
          <p className="page-subtitle mt-1">Поиск вакансий, отправленные отклики и сообщения работодателей в одном месте.</p>
        </div>
        <nav className="hh-view-switcher" aria-label="Разделы откликов">
          <button type="button" className={pageMode === 'activity' ? 'is-active' : ''} aria-pressed={pageMode === 'activity'} onClick={() => setPageMode('activity')}>
            <Send size={15} />Активность{userActionCount > 0 && <span>{userActionCount}</span>}
          </button>
          <button type="button" className={pageMode === 'settings' ? 'is-active' : ''} aria-pressed={pageMode === 'settings'} onClick={() => setPageMode('settings')}>
            <Settings2 size={15} />Настройки
          </button>
        </nav>
      </header>

      {pageMode === 'activity' && <section className={`hh-daily-overview panel-card shrink-0 p-5 is-${overview.tone}`} aria-live="polite">
        <div className="flex flex-wrap items-center gap-4">
          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${overview.tone === 'attention' ? 'bg-violet-400/10 text-violet-200' : overview.tone === 'active' ? 'hh-run-orbit is-active bg-sky-500/10 text-sky-200' : 'bg-emerald-500/10 text-emerald-300'}`}>
            {overview.tone === 'active' ? <Search size={20} /> : overview.tone === 'attention' ? <AlertTriangle size={20} /> : <Check size={20} />}
          </span>
          <div className="min-w-[240px] flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">Сейчас</p>
            <h2 className="mt-1 text-base font-semibold text-ink">{overview.title}</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{overview.detail}</p>
          </div>
          <div className="hh-daily-overview__stats" aria-label="Сводка откликов">
            <span><small>Сегодня</small><strong>{todaySent}</strong></span>
            <span><small>Нужно от вас</small><strong className={userActionCount ? 'text-violet-200' : ''}>{userActionCount}</strong></span>
            <span><small>Ответов отправлено</small><strong>{chatState?.repliesToday ?? 0}</strong></span>
          </div>
          <button type="button" className={`${overview.tone === 'active' ? 'btn-danger' : 'btn-primary'} shrink-0`} disabled={overview.tone === 'active' && stoppingRun} onClick={overview.action}>
            {overview.tone === 'active' ? stoppingRun ? <Loader2 className="animate-spin" size={15} /> : <Square size={14} /> : null}
            {overview.label}
            {overview.tone !== 'active' && <ArrowRight size={15} />}
          </button>
        </div>
        {activeRun && <div className="hh-run-progress mt-4" role="progressbar" aria-label="Прогресс поиска и откликов" aria-valuenow={applyPercent ?? undefined}><span className={applyPercent == null ? 'is-indeterminate' : ''} style={applyPercent == null ? undefined : { width: `${applyPercent}%` }} /></div>}
      </section>}

      {pageMode === 'settings' && <>
      <section className="grid shrink-0 gap-3 md:grid-cols-3" aria-label="Площадки для откликов">
        {PLATFORMS.map((item) => <button key={item.id} type="button" onClick={() => setDraft({ ...draft, platform: item.id })} className={`rounded-xl border p-4 text-left transition-colors ${draft.platform === item.id ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-surface-border bg-surface-light hover:bg-surface-hover'}`}>
          <div className="flex items-center justify-between gap-3"><b className="text-sm text-ink">{item.label}</b><span className={`rounded-full px-2 py-1 text-[11px] ${item.id === 'hh' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-sky-500/10 text-sky-200'}`}>{item.id === 'hh' ? 'Автоотклики' : 'Поиск вакансий'}</span></div>
          <p className="mt-2 text-xs text-ink-faint">{item.hint}</p>
        </button>)}
      </section>

      {draft.platform === 'hh' ? <section id="hh-platform-connection" className="panel-card shrink-0 scroll-mt-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`grid h-10 w-10 place-items-center rounded-full ${hhConnected ? 'bg-emerald-500/10 text-emerald-300' : hhSessionUnchecked ? 'bg-sky-500/10 text-sky-200' : 'bg-surface-elevated text-ink-muted'}`}>{hhSessionUnchecked ? <Loader2 className="animate-spin" size={19} /> : <Mail size={19} />}</div>
            <div><h2 className="panel-title">{hhConnected ? 'HH подключён' : hhSessionUnchecked ? 'Проверяю сессию HH' : 'Подключите аккаунт HH'}</h2><p className="text-xs text-ink-faint">{hhConnected ? 'Готово к поиску и сообщениям' : hhSessionUnchecked ? 'Это займёт не больше нескольких секунд' : 'Войдите по почте и коду из письма'}</p></div>
          </div>
          {hhConnected && <span className="flex items-center gap-1.5 text-sm text-emerald-300"><Check size={15} /> Готово</span>}
        </div>
        {!hhConnected && !hhSessionUnchecked && <div className="mt-4 flex max-w-xl flex-wrap gap-2">
          {!codeRequested ? <>
            <label className="min-w-[240px] flex-1" htmlFor="hh-login-email">
              <span className="label">Почта аккаунта HH</span>
              <input ref={emailRef} id="hh-login-email" name="email" autoComplete="email" className="field" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setAuthMessage(''); }} placeholder="name@example.com" aria-describedby="hh-auth-message" />
            </label>
            <button className="btn-primary self-end" disabled={busy === 'auth'} onClick={() => void requestLoginCode()}>{busy === 'auth' && <Loader2 className="animate-spin" size={15} />}Получить код от HH</button>
          </> : <>
            <label className="min-w-[200px] flex-1" htmlFor="hh-login-code">
              <span className="label">Код из письма HH</span>
              <input ref={codeRef} id="hh-login-code" name="one-time-code" className="field" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => { setCode(e.target.value); setAuthMessage(''); }} placeholder="123456" aria-describedby="hh-auth-message" />
            </label>
            <button className="btn-primary self-end" disabled={busy === 'auth'} onClick={() => void confirmLoginCode()}>{busy === 'auth' && <Loader2 className="animate-spin" size={15} />}Подключить HH</button>
            <button className="btn-ghost self-end" onClick={() => { setCodeRequested(false); setCode(''); setAuthMessage(''); }}>Изменить почту</button>
          </>}
        </div>}
        <p id="hh-auth-message" className="mt-2 min-h-4 text-xs text-ink-muted" role="status" aria-live="polite">{authMessage}</p>
      </section> : <section id="hh-platform-connection" className="panel-card shrink-0 scroll-mt-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div><h2 className="panel-title">Подключите {PLATFORMS.find((item) => item.id === draft.platform)?.label}</h2><p className="text-xs text-ink-faint">Вход выполняется вручную в обычном Chrome; сессия остаётся только на этом устройстве.</p></div>
          <button className="btn-primary" disabled={busy === 'browser'} onClick={() => void run('browser', () => assistant.openBrowser(draft.platform)).catch(() => undefined)}>{busy === 'browser' ? <Loader2 className="animate-spin" size={15} /> : <ExternalLink size={15} />}Открыть площадку</button>
        </div>
        {state?.message && <p className="mt-3 text-xs text-ink-muted">{state.message}</p>}
      </section>}

      {!connected ? (
        <div className="rounded-xl border border-dashed border-surface-border px-6 py-10 text-center text-sm text-ink-faint">
          Сначала откройте выбранную площадку и войдите в аккаунт. После этого запустите поиск.
        </div>
      ) : <>

      {draft.platform === 'hh' && <section id="hh-resume-selection" className="panel-card shrink-0 overflow-hidden">
        <div className="panel-header flex-wrap gap-3"><div><h2 className="panel-title">1. Резюме по умолчанию</h2><p className="mt-0.5 text-xs text-ink-faint">SkillCue загрузит все опубликованные резюме из HH и для каждой вакансии выберет наиболее близкое по роли. Здесь задаётся вариант только для спорных случаев.</p></div><button type="button" className="btn-ghost ml-auto" disabled={resumeLoading} onClick={() => void loadResumes()}>{resumeLoading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}Обновить из HH</button></div>
        <div className="p-5">
          {resumeLoadError && <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-sm text-amber-200"><p>{resumeLoadError}</p><button type="button" className="btn-ghost mt-2" disabled={resumeLoading} onClick={() => void loadResumes()}><RefreshCw size={14} />Повторить</button></div>}
          {resumeLoading && resumes.length === 0 && <p className="flex items-center gap-2 text-sm text-ink-faint"><Loader2 className="animate-spin" size={15} />Загружаю актуальное резюме из HH…</p>}
          {!resumeLoading && !resumeLoadError && resumes.length === 0 && <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-3 text-sm text-ink-muted"><p>Для отклика нужно опубликованное резюме в HH. Локальное резюме подходит для анализа, но HH не сможет отправить его работодателю.</p><button type="button" className="btn-secondary btn-sm mt-3" onClick={() => void window.electronAPI?.openExternal('https://hh.ru/applicant/resumes')}><ExternalLink size={14} />Открыть резюме в HH</button></div>}
          {resumes.length > 0 && <label className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-3"><FileText size={18} className="shrink-0 text-emerald-300" /><select className="field min-w-0 flex-1" aria-label="Резюме HH по умолчанию" value={draft.resumeTitles[0] ?? resumes[0].title} onChange={(event) => setDraft({ ...draft, resumeTitles: [event.target.value], resumeTitleContains: '' })}>{resumes.map((resume) => <option key={resume.id} value={resume.title}>{resume.title}</option>)}</select><span className="hidden text-xs text-emerald-300 sm:inline">Автовыбор включён</span></label>}
        </div>
      </section>}

      {draft.platform === 'hh' && <section className="panel-card shrink-0 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-[240px] flex-1">
            <div className="flex items-center gap-2"><Link2 size={17} className="text-emerald-300" /><h2 className="panel-title">Есть конкретная вакансия?</h2></div>
            <p className="mt-1 text-xs text-ink-faint">Вставьте ссылку HH. Сначала можно разобрать требования и подготовиться; немедленная отправка вынесена в отдельное подтверждаемое действие.</p>
            {searchParams.get('session') && <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-300"><Check size={14} />Открыто из готового разбора вакансии</p>}
          </div>
          <div className="grid w-full min-w-0 gap-2 lg:w-auto lg:min-w-[560px] lg:grid-cols-[minmax(0,1fr)_auto]">
            <input
              className={`field min-w-0 flex-1 ${vacancyUrlError ? 'border-amber-400/70' : ''}`}
              value={vacancyUrl}
              onChange={(event) => { setVacancyUrl(event.target.value); setVacancyUrlError(''); setDirectApplyConfirmed(false); }}
              onKeyDown={(event) => { if (event.key === 'Enter') prepareDirectVacancy(); }}
              placeholder="https://hh.ru/vacancy/135995132"
              aria-label="Ссылка на конкретную вакансию HH"
              aria-invalid={Boolean(vacancyUrlError)}
              aria-describedby="hh-direct-vacancy-help"
            />
            <button type="button" className="btn-primary shrink-0" disabled={busy !== ''} onClick={prepareDirectVacancy}>
              <Search size={15} />Разобрать и подготовиться
            </button>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.04] px-3 py-2 text-xs text-ink-muted lg:col-span-2">
              <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400" checked={directApplyConfirmed} onChange={(event) => { setDirectApplyConfirmed(event.target.checked); setVacancyUrlError(''); }} />
              <span>Отправить без дополнительного разбора. SkillCue использует выбранное резюме и остановится, если понадобится мой ответ.</span>
            </label>
            <button type="button" className="btn-secondary justify-center lg:col-span-2" disabled={busy !== ''} onClick={() => void applyDirectVacancy()}>
              {busy === 'direct' ? <Loader2 className="animate-spin" size={15} /> : <Send size={15} />}Отправить отклик сейчас
            </button>
          </div>
        </div>
        <p id="hh-direct-vacancy-help" className={`mt-2 min-h-4 text-xs ${vacancyUrlError ? 'text-amber-200' : 'text-ink-faint'}`} role={vacancyUrlError ? 'alert' : undefined}>{vacancyUrlError}</p>
      </section>}

      <section
        id="hh-search-settings"
        className={`panel-card shrink-0 overflow-hidden transition-shadow ${showSearchRequirement && !draft.query.trim() ? 'ring-2 ring-amber-400/50' : ''}`}
      >
        <div className="panel-header">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="panel-title">2. Что искать</h2>
              {!draft.query.trim() && <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200">Обязательный шаг</span>}
            </div>
            <p className="mt-0.5 text-xs text-ink-faint">Введите должность или запрос, по которому искать вакансии</p>
          </div>
        </div>
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <label className="block md:col-span-2">
            <span className="label">Должность или поисковый запрос</span>
            <input
              id="hh-search-query"
              className={`field ${showSearchRequirement && !draft.query.trim() ? 'border-amber-400/70 ring-2 ring-amber-400/20' : ''}`}
              value={draft.query}
              onChange={(e) => {
                setDraft({ ...draft, query: e.target.value });
                if (e.target.value.trim()) setShowSearchRequirement(false);
              }}
              placeholder="Например: QA Automation Engineer или тестировщик Python"
              aria-required="true"
              aria-invalid={showSearchRequirement && !draft.query.trim()}
              aria-describedby="hh-search-query-help"
            />
            <span id="hh-search-query-help" className={`mt-1.5 block text-xs ${showSearchRequirement && !draft.query.trim() ? 'font-medium text-amber-200' : 'text-ink-faint'}`}>
              {showSearchRequirement && !draft.query.trim()
                ? 'Заполните это поле — без запроса поиск вакансий не запустится.'
                : 'Напишите название нужной роли или ключевые слова.'}
            </span>
          </label>
          {draft.platform === 'hh' ? <>
            <label className="block">
              <span className="label">Формат работы</span>
              <select className="field" value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}>
                <option value="">Любой — максимум вакансий</option>
                <option value="remote">Только удалённо</option>
                <option value="fullDay">Полный день</option>
                <option value="flexible">Гибкий график</option>
              </select>
              <span className="mt-1.5 block text-xs text-ink-faint">Этот фильтр заметно меняет число вакансий в выдаче HH.</span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-surface-border bg-surface-light p-3">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-500" checked={draft.includeRelatedQueries} onChange={(e) => setDraft({ ...draft, includeRelatedQueries: e.target.checked })} />
              <span><b className="block text-sm font-medium text-ink">Искать близкие названия роли</b><span className="mt-1 block text-xs leading-relaxed text-ink-faint">SkillCue сверит их с выбранным резюме: manual QA не расширяется до автоматизации.</span></span>
            </label>
            <label className="block md:col-span-2">
              <span className="label">Дополнительные направления</span>
              <textarea
                className="field min-h-20 resize-y"
                value={draft.additionalQueries.join('\n')}
                onChange={(e) => setDraft({ ...draft, additionalQueries: e.target.value.split(/\r?\n/) })}
                placeholder={'Например:\nJunior Game Developer C#\nFullstack Python Developer'}
              />
              <span className="mt-1.5 block text-xs text-ink-faint">По одному запросу в строке. Используется выбранное выше резюме; SkillCue не добавляет в него несуществующий опыт.</span>
            </label>
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2.5 text-xs text-ink-muted md:col-span-2"><Check size={15} className="shrink-0 text-emerald-300" /><span>Без ограничения региона · {draft.schedule === 'remote' ? 'только удалённо' : draft.schedule ? 'выбранный формат работы' : 'любой формат работы'} · дубликаты между запросами удаляются.</span></div>
          </> : draft.platform === 'linkedin' ? <>
            <label className="block"><span className="label">Локация</span><input className="field" value={draft.linkedinLocation} onChange={(e) => setDraft({ ...draft, linkedinLocation: e.target.value })} placeholder="Russia или Remote" /></label>
            <label className="flex items-center gap-2 text-sm text-ink-muted"><input type="checkbox" checked={draft.linkedinEasyApplyOnly} onChange={(e) => setDraft({ ...draft, linkedinEasyApplyOnly: e.target.checked })} />Только Easy Apply</label>
          </> : <label className="block"><span className="label">Город в URL Avito</span><input className="field" value={draft.avitoCity} onChange={(e) => setDraft({ ...draft, avitoCity: e.target.value })} placeholder="all, moskva, krasnoyarsk" /></label>}
          {draft.platform !== 'hh' && <>
            <label className="block"><span className="label">Формат работы</span><select className="field" value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}><option value="">Любой</option><option value="remote">Удалённо</option><option value="fullDay">Полный день</option><option value="flexible">Гибкий график</option></select></label>
            <label className="block"><span className="label">Зарплата от</span><input className="field" type="number" min={0} step={10000} value={draft.salaryFrom ?? ''} onChange={(e) => setDraft({ ...draft, salaryFrom: e.target.value ? Number(e.target.value) : null })} placeholder="150 000" /></label>
          </>}
          <button type="button" className="flex items-center gap-2 text-sm text-ink-muted md:col-span-2" onClick={() => setShowAdvanced(!showAdvanced)}><ChevronDown className={showAdvanced ? 'rotate-180' : ''} size={16} />Дополнительные фильтры</button>
          {showAdvanced && <div className="grid gap-4 md:col-span-2 md:grid-cols-2">
            {draft.platform === 'hh' && <>
              <label className="block"><span className="label">Регион</span><select className="field" value={draft.area} onChange={(e) => setDraft({ ...draft, area: e.target.value })}><option value="">Не ограничивать</option><option value="113">Вся Россия</option><option value="1">Москва</option><option value="2">Санкт-Петербург</option></select></label>
              <label className="block"><span className="label">Опыт</span><select className="field" value={draft.experience} onChange={(e) => setDraft({ ...draft, experience: e.target.value })}><option value="">Любой</option><option value="noExperience">Без опыта</option><option value="between1And3">1–3 года</option><option value="between3And6">3–6 лет</option><option value="moreThan6">Более 6 лет</option></select></label>
              <label className="block"><span className="label">Зарплата от</span><input className="field" type="number" min={0} step={10000} value={draft.salaryFrom ?? ''} onChange={(e) => setDraft({ ...draft, salaryFrom: e.target.value ? Number(e.target.value) : null })} placeholder="150 000" /></label>
            </>}
            <label className="block"><span className="label">Исключить слова</span><input className="field" value={excludedKeywords} onChange={(e) => setExcludedKeywords(e.target.value)} placeholder="стажёр, продажи" /></label>
            <label className="block"><span className="label">Исключить работодателей</span><input className="field" value={draft.excludedEmployers.join(', ')} onChange={(e) => setDraft({ ...draft, excludedEmployers: splitList(e.target.value) })} placeholder="Название компании" /></label>
          </div>}
        </div>
      </section>

      <section className="panel-card shrink-0 p-5">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <span className="min-w-[240px] flex-1">
            <b className="block text-sm text-ink">3. Выбрать действие и запустить</b>
            <span className="text-xs text-ink-faint">
              {draft.autoSend
                ? `SkillCue найдёт вакансии и может отправить до ${draft.dailyLimit} откликов за день.`
                : 'SkillCue только найдёт вакансии и добавит их в очередь. Отправлять их вы будете по одной после проверки.'}
            </span>
            {startRequirement && <span id="auto-apply-requirement" className="mt-2 flex flex-wrap items-center gap-1.5 text-xs font-medium text-amber-200"><AlertTriangle size={14} />Для запуска: {startRequirement}<button type="button" className="rounded-md px-1.5 py-0.5 font-semibold text-amber-100 underline decoration-amber-300/60 underline-offset-2 hover:bg-amber-400/10" onClick={focusMissingRequirement}>Перейти к полю</button></span>}
            {!startRequirement && <span id="auto-apply-requirement" aria-live="polite" className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${searchLaunchBusy ? 'text-sky-200' : 'text-emerald-300'}`}>{searchLaunchBusy ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />}{searchLaunchBusy ? searchLaunchLabel : draft.autoSend ? 'Подходящие отклики будут отправляться автоматически' : 'Отклики не будут отправлены автоматически'}</span>}
            {automationError && <span role="alert" className="mt-2 block text-xs text-red-300">{automationError}</span>}
          </span>
          {draft.platform === 'hh' && <fieldset className="min-w-[300px] rounded-xl border border-surface-border bg-surface-light p-3">
            <legend className="px-1 text-xs font-semibold text-ink">Что делать с найденными вакансиями</legend>
            <label className={`mt-1 flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${!draft.autoSend ? 'border-emerald-400/35 bg-emerald-400/[0.06]' : 'border-transparent'}`}>
              <input type="radio" name="hh-run-mode" className="mt-0.5 accent-emerald-500" checked={!draft.autoSend} onChange={() => setDraft({ ...draft, autoSend: false })} />
              <span><b className="block text-xs text-ink">Добавить в очередь</b><span className="text-[11px] leading-relaxed text-ink-faint">Рекомендуется: сначала проверить соответствие и письмо.</span></span>
            </label>
            <label className={`mt-1 flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${draft.autoSend ? 'border-amber-400/35 bg-amber-400/[0.06]' : 'border-transparent'}`}>
              <input type="radio" name="hh-run-mode" className="mt-0.5 accent-amber-400" checked={draft.autoSend} onChange={() => setDraft({ ...draft, autoSend: true })} />
              <span><b className="block text-xs text-ink">Отправлять автоматически</b><span className="text-[11px] leading-relaxed text-ink-faint">SkillCue остановится на неизвестных вопросах.</span></span>
            </label>
            {draft.autoSend && <label className="mt-2 block border-t border-surface-border pt-2">
              <span className="label">Максимум откликов в день</span>
              <input type="number" min={1} max={200} className="field mt-1 w-28 py-1.5" value={draft.dailyLimit} onChange={(event) => setDraft({ ...draft, dailyLimit: Math.max(1, Math.min(200, Number(event.target.value) || 1)) })} />
            </label>}
          </fieldset>}
          {draft.platform === 'hh' && <div className="min-w-[280px] rounded-xl border border-surface-border bg-surface-light p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
              <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={draft.autoRunDaily} onChange={(event) => setDraft({ ...draft, autoRunDaily: event.target.checked })} />
              <Clock3 size={16} />Повторять поиск каждый день
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2 pl-6 text-xs text-ink-muted">
              <span>Время:</span>
              <select className="field w-24 py-1.5" value={draft.autoRunHour} onChange={(e) => setDraft({ ...draft, autoRunHour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select>
              {scheduleDirty && <button type="button" className="btn-ghost btn-sm" disabled={busy !== ''} onClick={() => void saveSchedule()}>{busy === 'schedule' && <Loader2 className="animate-spin" size={13} />}Сохранить</button>}
            </div>
            <p className="mt-2 pl-6 text-[11px] leading-relaxed text-ink-faint">
              {draft.autoRunDaily
                ? state?.nextRunAt && !scheduleDirty
                  ? `Следующий автоматический запуск: ${new Date(state.nextRunAt).toLocaleString('ru-RU')}. Запуск сейчас его не отменяет.`
                  : `После сохранения SkillCue будет запускать поиск ежедневно в ${String(draft.autoRunHour).padStart(2, '0')}:00.`
                : 'Расписание выключено. Кнопка выполнит только один запуск сейчас.'}
            </p>
          </div>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy !== ''} onClick={() => void saveSettingsOnly()}>{busy === 'settings' ? <Loader2 className="animate-spin" size={15} /> : <Check size={15} />}Сохранить без запуска</button>
            {activeRun
              ? <button type="button" className="btn-danger min-w-[220px] justify-center" aria-busy={stoppingRun} disabled={stoppingRun} onClick={() => void stopAutomation()}>{stoppingRun ? <Loader2 className="animate-spin" size={16} /> : <Square size={15} />}{stoppingRun ? 'Останавливаем…' : 'Остановить поиск и отклики'}</button>
              : <button type="button" className="btn-primary min-w-[220px] justify-center" aria-describedby="auto-apply-requirement" disabled={busy !== ''} onClick={() => void launchAutomation()}><Search size={16} />{searchLaunchLabel}</button>}
          </div>
        </div>
      </section>

      {draft.platform === 'hh' && chat && <section id="hh-chat-settings" className="panel-card shrink-0 scroll-mt-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`grid h-10 w-10 place-items-center rounded-full ${chatState?.enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-surface-elevated text-ink-muted'}`}><MessageCircle size={19} /></div>
            <div><h2 className="panel-title">Автоответы HR</h2><p className="text-xs text-ink-faint">{chatState?.enabled ? 'Включены: SkillCue проверяет входящие и отвечает только по подтверждённым данным' : 'Выключены: входящие сообщения не обрабатываются автоматически'}</p></div>
          </div>
          <div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost" onClick={() => navigate('/calendar')}><CalendarDays size={14} />Календарь</button><button type="button" className="btn-primary" disabled={chatBusy} onClick={() => void toggleChat()}>{chatState?.enabled ? 'Выключить' : 'Включить автоответы'}</button></div>
        </div>
        <div className={`mt-4 rounded-xl border p-4 ${calendarState?.settings.availabilityConfigured ? 'border-emerald-500/20 bg-emerald-500/[0.04]' : 'border-amber-400/25 bg-amber-400/[0.06]'}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <CalendarDays className={calendarState?.settings.availabilityConfigured ? 'text-emerald-300' : 'text-amber-200'} size={18} />
              <div className="min-w-0"><p className="text-sm font-semibold text-ink">Когда можно назначать созвоны</p><p className="mt-1 text-xs text-ink-muted">{calendarState ? formatAvailabilitySummary(calendarState.settings) : 'Загружаю доступность…'}</p></div>
            </div>
            {calendarState?.settings.availabilityConfigured && <button type="button" className="btn-ghost btn-sm" onClick={() => setAvailabilityOpen((open) => !open)}>{availabilityOpen ? 'Свернуть' : 'Изменить'}</button>}
          </div>
          {calendarState && (availabilityOpen || !calendarState.settings.availabilityConfigured) && <div className="mt-4 border-t border-surface-border pt-4">
            <p className="mb-3 text-xs text-ink-muted">Бот примет подходящий вариант HR, а при несовпадении предложит три ближайших свободных слота.</p>
            <AvailabilityEditor compact settings={calendarState.settings} onSave={saveAvailabilityAndEnableChat} submitLabel={chatState?.enabled ? 'Сохранить' : 'Сохранить и включить автоответы'} />
          </div>}
        </div>
        {(chatState?.confirmedFacts.length ?? 0) > 0 && <details className="mt-4 rounded-xl border border-surface-border bg-surface-light/50 p-4"><summary className="cursor-pointer text-sm font-medium text-ink">Запомненные условия: {chatState?.confirmedFacts.length}</summary><div className="mt-3 space-y-2">{chatState?.confirmedFacts.map((fact) => <div key={fact.id} className="flex items-start gap-3 rounded-lg border border-surface-border p-3"><div className="min-w-0 flex-1"><p className="text-xs font-medium text-ink">{fact.question}</p><p className="mt-1 text-xs text-ink-muted">{fact.answer}</p></div><button type="button" className="btn-ghost btn-sm shrink-0" disabled={chatBusy} onClick={() => void forgetChatFact(fact.id)}><Trash2 size={13} />Удалить</button></div>)}</div></details>}
        {(chatError || chatState?.error) && <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-200">{chatError || chatState?.error}</p>}
      </section>}

      {/* The full questionnaire moved to /applications/hr-profile so the vacancy queue stays compact.
      {draft.platform === 'hh' && state && (pendingScreeningVacancies.length > 0 || state.screeningFacts.length > 0) && (
        <section className="panel-card shrink-0 overflow-hidden border-amber-400/25">
          <div className="panel-header flex-wrap gap-3 bg-amber-400/[0.04]">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-400/10 text-amber-100">
                <HelpCircle size={20} />
              </div>
              <div>
                <h2 className="panel-title">Вопросы работодателей</h2>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {pendingScreeningVacancies.length > 0
                    ? `${pendingScreeningVacancies.length} ${pendingScreeningVacancies.length === 1 ? 'вакансия ждёт' : 'вакансии ждут'} вашего решения. Остальная очередь продолжает работать.`
                    : 'Сохранённые ответы можно проверить или удалить в любой момент.'}
                </p>
              </div>
            </div>
            {state.screeningFacts.length > 0 && (
              <button type="button" className="btn-ghost ml-auto" onClick={() => setShowSavedAnswers((open) => !open)}>
                <ShieldCheck size={15} />
                Сохранённые ответы: {state.screeningFacts.length}
                <ChevronDown className={showSavedAnswers ? 'rotate-180' : ''} size={14} />
              </button>
            )}
          </div>

          {pendingScreeningVacancies.map((vacancy) => (
            <div key={vacancy.key} className="border-t border-surface-border p-5 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-ink">{vacancy.title}</p>
                  <p className="mt-0.5 text-xs text-ink-faint">{vacancy.company}{vacancy.salary ? ` · ${vacancy.salary}` : ''}</p>
                </div>
                <span className="rounded-full bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-100">
                  Нужен ваш ответ
                </span>
              </div>
              <div className="mt-4 space-y-4">
                {vacancy.pendingQuestions?.map((question, questionIndex) => {
                  const key = screeningDraftKey(vacancy.key, question.id);
                  const value = screeningDrafts[key] ?? { answer: '', selectedOptions: [] };
                  return (
                    <fieldset key={question.id} className="rounded-xl border border-surface-border bg-surface-light p-4">
                      <legend className="px-1 text-sm font-medium leading-relaxed text-ink">
                        {questionIndex + 1}. {question.prompt}
                      </legend>
                      {question.kind === 'text' ? (
                        <textarea
                          className="field mt-3 min-h-24 resize-y"
                          value={value.answer}
                          maxLength={2000}
                          onChange={(event) => updateScreeningText(vacancy.key, question.id, event.target.value)}
                          placeholder="Напишите честный ответ — SkillCue перенесёт его в форму HH"
                        />
                      ) : question.kind === 'select' ? (
                        <select
                          className="field mt-3"
                          value={value.selectedOptions[0] ?? ''}
                          onChange={(event) => updateScreeningOptions(vacancy.key, question.id, event.target.value, false)}
                        >
                          <option value="" disabled>Выберите ответ</option>
                          {question.options.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      ) : (
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {question.options.map((option) => (
                            <label key={option} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm transition-colors ${value.selectedOptions.includes(option) ? 'border-emerald-500/45 bg-emerald-500/[0.07] text-ink' : 'border-surface-border text-ink-muted hover:bg-surface-hover'}`}>
                              <input
                                type={question.kind === 'multiple' ? 'checkbox' : 'radio'}
                                name={`${vacancy.key}-${question.id}`}
                                checked={value.selectedOptions.includes(option)}
                                onChange={() => updateScreeningOptions(vacancy.key, question.id, option, question.kind === 'multiple')}
                                className="mt-0.5 h-4 w-4 accent-emerald-500"
                              />
                              <span>{option}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </fieldset>
                  );
                })}
              </div>
              <label className="mt-4 flex cursor-pointer items-start gap-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-emerald-500"
                  checked={rememberScreening[vacancy.key] ?? true}
                  onChange={(event) => setRememberScreening((current) => ({ ...current, [vacancy.key]: event.target.checked }))}
                />
                <span><b className="text-ink">Запомнить мои ответы</b> и использовать снова только для вопросов с тем же смыслом. Для разового решения выключите этот флажок.</span>
              </label>
              <p className="mt-2 flex items-start gap-2 text-xs text-ink-faint">
                <ShieldCheck className="mt-0.5 shrink-0 text-emerald-300" size={14} />
                SkillCue не трактует согласие на Саудовскую Аравию как согласие на релокацию в любую страну и не отправляет ответ до нажатия кнопки ниже.
              </p>
              {screeningError[vacancy.key] && <p className="mt-3 text-xs text-red-300" role="alert">{screeningError[vacancy.key]}</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy !== ''}
                  onClick={() => void submitScreeningAnswers(vacancy)}
                >
                  {busy === `screening-${vacancy.key}` ? <Loader2 className="animate-spin" size={15} /> : <Send size={15} />}
                  Заполнить на HH и продолжить отклик
                </button>
                <button type="button" className="btn-ghost" disabled={busy !== ''} onClick={() => void run('open', () => assistant.openVacancy(vacancy.key))}>
                  <ExternalLink size={14} />Открыть вакансию
                </button>
              </div>
            </div>
          ))}

          {showSavedAnswers && state.screeningFacts.length > 0 && (
            <div className="border-t border-surface-border bg-surface-light/40 p-5">
              <div className="mb-3">
                <p className="text-sm font-semibold text-ink">Что SkillCue запомнил</p>
                <p className="mt-0.5 text-xs text-ink-faint">Это ваши подтверждённые ответы, а не догадки AI.</p>
              </div>
              <div className="space-y-2">
                {state.screeningFacts.map((fact) => (
                  <div key={fact.id} className="flex items-start gap-3 rounded-lg border border-surface-border bg-surface-light p-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-xs font-medium text-ink">{fact.question}</p>
                      <p className="mt-1 break-words text-xs text-ink-muted">{fact.selectedOptions.length > 0 ? fact.selectedOptions.join(', ') : fact.answer}</p>
                    </div>
                    <button
                      type="button"
                      className="btn-ghost btn-sm shrink-0 text-red-300"
                      aria-label="Удалить сохранённый ответ"
                      disabled={busy !== ''}
                      onClick={() => void forgetScreeningFact(fact.id)}
                    >
                      {busy === `forget-${fact.id}` ? <Loader2 className="animate-spin" size={13} /> : <Trash2 size={13} />}
                      Удалить
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
      */}
      </>}
      </>}

      {pageMode === 'activity' && <>
      {state && featuredRun && <section id="hh-run-panel" className="panel-card shrink-0 scroll-mt-5 overflow-hidden">
        <div className="panel-header flex-wrap gap-3">
          <div className="flex items-center gap-2.5">
            <span className={`hh-run-orbit grid h-9 w-9 place-items-center rounded-xl ${activeRun ? 'is-active bg-sky-500/10 text-sky-200' : 'bg-surface-elevated text-ink-muted'}`}>
              {activeRun ? <Search size={17} /> : <Check size={17} />}
            </span>
            <div><h2 className="panel-title">Поиск вакансий</h2><p className="text-xs text-ink-faint">{runTriggerLabel(featuredRun.trigger)} · {new Date(featuredRun.startedAt).toLocaleString('ru-RU')}</p></div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${runStatusMeta(featuredRun.status).tone}`}>{activeRun && <Loader2 className="animate-spin" size={12} />}{stoppingRun ? 'Останавливается' : runStatusMeta(featuredRun.status).label}</span>
            {activeRun && <button type="button" className="btn-danger btn-sm" disabled={stoppingRun} onClick={() => void stopAutomation()}>{stoppingRun ? <Loader2 className="animate-spin" size={13} /> : <Square size={12} />}{stoppingRun ? 'Ждём текущий шаг' : 'Остановить'}</button>}
          </div>
        </div>
        <details className="group border-t border-surface-border" open={activeRun ? true : undefined}>
          <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-3.5 hover:bg-surface-hover/35">
            <div className="min-w-0 flex-1" aria-live="polite">
              <p className={`text-sm font-medium ${featuredRun.status === 'failed' ? 'text-red-300' : featuredRun.status === 'attention' ? 'text-amber-200' : 'text-ink'}`}>{activeRun ? 'Текущий запуск' : 'Последний запуск'}</p>
              <p className="mt-1 text-xs text-ink-muted">
                {featuredRun.found} найдено · <span className="text-emerald-300">{featuredRun.sent} отправлено</span>{featuredRun.alreadyApplied > 0 ? ` · ${featuredRun.alreadyApplied} уже было` : ''}{featuredRun.needsAttention > 0 ? <span className="text-amber-200"> · {featuredRun.needsAttention} требуют внимания</span> : null}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-ink-muted">
              {activeRun ? 'Ход выполнения' : 'Подробнее'}<ChevronDown className="transition-transform group-open:rotate-180" size={14} />
            </span>
          </summary>
          <div className="border-t border-surface-border p-4">
            {activeRun && <div className="hh-run-progress" role="progressbar" aria-label="Прогресс поиска и откликов" aria-valuenow={applyPercent ?? undefined}><span className={applyPercent == null ? 'is-indeterminate' : ''} style={applyPercent == null ? undefined : { width: `${applyPercent}%` }} /></div>}
            <p className={`${activeRun ? 'mt-3' : ''} text-sm leading-relaxed ${featuredRun.status === 'failed' ? 'text-red-300' : featuredRun.status === 'attention' ? 'text-amber-200' : 'text-ink-muted'}`}>{featuredRun.message || (activeRun ? 'Запуск выполняется…' : 'Запуск завершён.')}</p>
            {state.lastScanSummary && state.lastScanSummary.platform === draft.platform && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border border-surface-border bg-surface-light/60 px-3 py-2 text-xs text-ink-muted">
              <span>Направлений: <b className="text-ink">{state.lastScanSummary.queries.length}</b></span>
              <span>Новых: <b className="text-emerald-300">{state.lastScanSummary.newVacancies}</b></span>
              <span>Уже обработано: <b className="text-ink">{state.lastScanSummary.alreadyProcessed}</b></span>
              <span>Страниц: <b className="text-ink">{state.lastScanSummary.pagesScanned}</b></span>
              <details className="group/queries ml-auto"><summary className="cursor-pointer text-sky-200">Какие запросы</summary><div className="mt-2 flex max-w-2xl flex-wrap gap-1.5">{state.lastScanSummary.queries.map((query) => <span key={query} className="rounded-full bg-sky-500/10 px-2 py-1 text-sky-100">{query}</span>)}</div></details>
            </div>}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {([
                ['Найдено', featuredRun.found, 'text-sky-200'],
                ['Проверено', featuredRun.attempted, 'text-ink'],
                ['Отправлено', featuredRun.sent, 'text-emerald-300'],
                ['Уже было', featuredRun.alreadyApplied, 'text-sky-200'],
                ['Внимание', featuredRun.needsAttention, featuredRun.needsAttention ? 'text-amber-200' : 'text-ink-muted'],
              ] as const).map(([label, value, tone]) => <div key={label} className="hh-run-stat rounded-xl border border-surface-border bg-surface/35 px-3 py-2.5"><span className="block text-xs font-semibold uppercase tracking-[0.1em] text-ink-faint">{label}</span><strong className={`mt-0.5 block text-xl tabular-nums ${tone}`}>{value}</strong></div>)}
            </div>
            <div className="mt-3 flex justify-end">
              <button type="button" className="btn-ghost btn-sm tip" data-tip="Сохранить технический отчёт" aria-label="Собрать диагностику" disabled={busy !== ''} onClick={() => void collectAutomationDiagnostics()}>{busy === 'diagnostics' ? <Loader2 className="animate-spin" size={14} /> : <FileText size={14} />}Диагностика</button>
            </div>
            {previousRuns.length > 0 && <details className="group mt-3 overflow-hidden rounded-xl border border-surface-border">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-medium text-ink-muted hover:bg-surface-hover/40 hover:text-ink"><ChevronDown className="transition-transform group-open:rotate-180" size={14} />История запусков · {previousRuns.length}</summary>
              <div className="divide-y divide-surface-border border-t border-surface-border">{previousRuns.map((item) => {
                const meta = runStatusMeta(item.status);
                return <div key={item.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-xs">
                  <span className={`h-2 w-2 rounded-full ${item.status === 'completed' ? 'bg-emerald-400' : item.status === 'attention' ? 'bg-amber-300' : item.status === 'stopped' ? 'bg-ink-faint' : 'bg-red-400'}`} />
                  <span className="min-w-[165px] text-ink-muted">{runTriggerLabel(item.trigger)} · {new Date(item.startedAt).toLocaleString('ru-RU')}</span>
                  <span className="ml-auto text-ink-faint">{item.found} найдено</span><span className="text-emerald-300">{item.sent} отправлено</span>{item.alreadyApplied > 0 && <span className="text-sky-200">{item.alreadyApplied} уже было</span>}
                  <span className={`rounded-full px-2 py-0.5 ${meta.tone}`}>{meta.label}</span>
                </div>;
              })}</div>
            </details>}
          </div>
        </details>
      </section>}

      <section id="hh-conversations-panel" className="panel-card shrink-0 scroll-mt-5 overflow-hidden">
        <div className="panel-header flex-wrap gap-3"><div><h2 className="panel-title">{queuePanelMeta.title}</h2><p className="mt-0.5 text-xs text-ink-faint">{queuePanelMeta.detail}</p></div>{queueView === 'active' && draft.platform === 'hh' && platformMatches && state?.queuePaused ? <span className="ml-auto flex items-center gap-1.5 text-xs text-ink-muted"><Square size={11} /> Очередь приостановлена</span> : queueView === 'active' && draft.platform === 'hh' && platformMatches && state?.config.autoRunDaily ? <span className="ml-auto flex items-center gap-1.5 text-xs text-emerald-300"><span className="sc-dot sc-dot--live" /> Автоочередь включена</span> : null}</div>
        <div className="flex flex-wrap gap-2 border-b border-surface-border px-5 py-3" aria-label="Фильтры вакансий">
          {([
            ['active', 'В работе', activeVacancyCount],
            ['sent', 'Отправлено', sentVacancyCount],
            ...(draft.platform === 'hh' ? [
              ['dialogs', 'Диалоги', conversationCount],
              ['replies', 'Ответы', chatState?.replyHistory.length ?? 0],
            ] as const : []),
            ['archive', 'Пропущено', archivedVacancyCount],
          ] as const).map(([id, label, count]) => <button key={id} type="button" aria-pressed={queueView === id} onClick={() => setQueueView(id)} className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${queueView === id ? 'bg-emerald-500/15 text-emerald-200' : 'bg-surface-light text-ink-muted hover:bg-surface-hover'}`}>{label} · {count}</button>)}
        </div>
        {queueView === 'dialogs' && <div className="flex flex-wrap items-center gap-2 border-b border-surface-border bg-surface/25 px-5 py-2.5" aria-label="Этапы диалогов">
          <span className="mr-1 text-xs font-medium text-ink-faint">Показать:</span>
          {([
            ['all', 'Все', conversationCount],
            ['waiting', 'Ждём сообщения', (chatState?.conversations ?? []).filter((item) => item.stage === 'waiting').length],
            ['bot', 'Бот-рекрутер', (chatState?.conversations ?? []).filter((item) => item.stage === 'bot').length],
            ['hr', 'HR / человек', (chatState?.conversations ?? []).filter((item) => item.stage === 'hr').length],
          ] as const).map(([id, label, count]) => <button key={id} type="button" className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${conversationStage === id ? 'bg-sky-500/12 text-sky-200' : 'text-ink-muted hover:bg-surface-hover'}`} aria-pressed={conversationStage === id} onClick={() => setConversationStage(id)}>{label} · {count}</button>)}
        </div>}
        <div className="divide-y divide-surface-border">
          {queueView === 'replies' ? (visibleReplyHistory.length === 0 ? <div className="flex min-h-[180px] items-center justify-center p-8 text-center"><div className="max-w-sm"><MessageCircle className="mx-auto text-ink-faint" size={22} /><p className="mt-3 text-sm font-semibold text-ink">{emptyQueueCopy.title}</p><p className="mt-1 text-xs leading-relaxed text-ink-muted">{emptyQueueCopy.detail}</p>{emptyQueueCopy.action && <button type="button" className="btn-secondary btn-sm mt-4" disabled={chatBusy || chatState?.polling} onClick={emptyQueueCopy.action}>{chatBusy || chatState?.polling ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}{emptyQueueCopy.actionLabel}</button>}</div></div> : shownReplyHistory.map((entry) => <article key={entry.id} className="px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><p className="break-words text-sm font-semibold text-ink">{entry.vacancyTitle}</p><p className="mt-0.5 break-words text-xs text-ink-faint">{entry.companyName}</p></div>
              <div className="flex flex-wrap items-center justify-end gap-2"><span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">Отправлено</span><span className="text-xs text-ink-faint">{chatReplySourceLabel(entry.source)} · {entry.sentAt ? new Date(entry.sentAt).toLocaleString('ru-RU') : 'время уточняется'}</span></div>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <div className="rounded-xl border border-surface-border bg-surface/35 p-3"><p className="text-xs font-semibold uppercase tracking-[0.1em] text-sky-300">Сообщение HR</p><p className="mt-1.5 break-words text-sm leading-relaxed text-ink-muted">{entry.recruiterMessage}</p></div>
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3"><p className="text-xs font-semibold uppercase tracking-[0.1em] text-emerald-300">Ответ от вашего имени</p><p className="mt-1.5 break-words text-sm leading-relaxed text-ink">{entry.reply}</p></div>
            </div>
            <div className="mt-3 flex justify-end"><button type="button" className="btn-ghost btn-sm" onClick={() => void window.electronAPI?.openExternal('https://hh.ru/applicant/negotiations').catch((error) => setChatError(errorMessage(error, 'Не удалось открыть диалоги HH.')))}><ExternalLink size={14} />Открыть диалоги HH</button></div>
          </article>)) : queueView === 'dialogs' ? (visibleConversations.length === 0 ? <div className="flex min-h-[180px] items-center justify-center p-8 text-center"><div className="max-w-sm"><MessageCircle className="mx-auto text-ink-faint" size={22} /><p className="mt-3 text-sm font-semibold text-ink">{emptyQueueCopy.title}</p><p className="mt-1 text-xs leading-relaxed text-ink-muted">{emptyQueueCopy.detail}</p>{emptyQueueCopy.action && <button type="button" className="btn-secondary btn-sm mt-4" disabled={chatBusy || chatState?.polling} onClick={emptyQueueCopy.action}>{chatBusy || chatState?.polling ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}{emptyQueueCopy.actionLabel}</button>}</div></div> : shownConversations.map((conversation) => {
            const expanded = selectedConversationKey === conversation.key;
            const replies = (chatState?.replyHistory ?? []).filter((entry) => entry.negotiationKey === conversation.key);
            const decision = (chatState?.pendingDecisions ?? []).find((entry) => entry.negotiationKey === conversation.key);
            return <article key={conversation.key} className="hh-queue-row">
              <button
                type="button"
                className="flex w-full items-start gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-hover/35"
                aria-expanded={expanded}
                onClick={() => setSelectedConversationKey(expanded ? '' : conversation.key)}
              >
                <MessageCircle size={17} className={conversation.stage === 'bot' ? 'text-violet-300' : conversation.stage === 'hr' ? 'text-sky-300' : 'text-ink-faint'} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{conversation.vacancyTitle}</span>
                  <span className="block text-xs text-ink-faint">{conversation.companyName}</span>
                  {conversation.lastMessage && <span className="mt-1 block truncate text-xs text-ink-muted">{conversation.lastMessageMine ? 'SkillCue: ' : 'Работодатель: '}{conversation.lastMessage}</span>}
                </span>
                {conversation.needsUserInput ? <span className="rounded-full bg-violet-400/10 px-2.5 py-1 text-xs text-violet-100">Нужен ответ</span> : conversation.stage === 'waiting' ? <span className="rounded-full bg-surface-elevated px-2.5 py-1 text-xs text-ink-muted">Сообщений ещё нет</span> : <span className="rounded-full bg-sky-500/10 px-2.5 py-1 text-xs text-sky-200">{conversation.lastMessageMine ? 'SkillCue ответил' : 'Ждёт ответа'}</span>}
                <ChevronDown size={15} className={`mt-1 shrink-0 text-ink-faint transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>
              {expanded && <div className="border-t border-surface-border bg-surface/25 px-5 py-4">
                {conversation.lastMessage && <div className="rounded-xl border border-surface-border bg-surface-light/45 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Последнее сообщение</p>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">{conversation.lastMessage}</p>
                </div>}
                {decision && <div className="mt-3 rounded-xl border border-violet-400/20 bg-violet-400/[0.04] p-3">
                  <p className="text-xs font-semibold text-violet-100">Нужен ваш ответ</p>
                  <p className="mt-1 text-sm text-ink-muted">{decision.question}</p>
                  {hhConnected && <button type="button" className="btn-secondary btn-sm mt-3" onClick={focusHrDecisions}>Ответить</button>}
                </div>}
                {replies.length > 0 && <div className="mt-3 space-y-2">
                  {replies.slice(-3).map((entry) => <div key={entry.id} className="grid gap-1 rounded-xl border border-surface-border p-3 text-xs">
                    <p className="text-ink-muted">HR: {entry.recruiterMessage}</p>
                    <p className="text-ink">SkillCue: {entry.reply}</p>
                  </div>)}
                </div>}
                <div className="mt-3 flex justify-end"><button type="button" className="btn-ghost btn-sm" onClick={() => void window.electronAPI?.openExternal('https://hh.ru/applicant/negotiations').catch((error) => setChatError(errorMessage(error, 'Не удалось открыть диалоги HH.')))}><ExternalLink size={14} />Открыть в HH</button></div>
              </div>}
            </article>;
          })) : visibleQueue.length === 0 ? <div className="flex min-h-[180px] items-center justify-center p-8 text-center"><div className="max-w-sm"><Send className="mx-auto text-ink-faint" size={22} /><p className="mt-3 text-sm font-semibold text-ink">{emptyQueueCopy.title}</p><p className="mt-1 text-xs leading-relaxed text-ink-muted">{emptyQueueCopy.detail}</p>{emptyQueueCopy.action && <button type="button" className="btn-secondary btn-sm mt-4" onClick={emptyQueueCopy.action}>{emptyQueueCopy.actionLabel}</button>}</div></div> : shownQueue.map((item) => {
            const status = queueStatus(item);
            const actionable = item.status === 'new' || item.status === 'opened' || item.status === 'prepared';
            return <div key={item.key} className="hh-queue-row flex flex-wrap items-start gap-3 px-5 py-3 transition-colors hover:bg-surface-hover/35">
              <div className="min-w-[220px] flex-1">
                <p className="break-words text-sm font-medium text-ink">{item.title}</p>
                <p className="break-words text-xs text-ink-faint">{item.company}{item.salary ? ` · ${item.salary}` : ''}</p>
                {item.selectedResumeTitle && <p className="mt-1 flex items-center gap-1.5 text-[11px] text-sky-200"><FileText size={12} />Резюме: {item.selectedResumeTitle}</p>}
                {item.reason && <p className="mt-1 line-clamp-1 break-words text-xs text-ink-muted" title={item.reason}>{item.reason}</p>}
                {(item.preparationNotes?.length ?? 0) > 0 && <details className="mt-1.5 text-xs"><summary className="cursor-pointer text-violet-200">Подготовка · {item.preparationNotes?.length}</summary><ul className="mt-1 space-y-0.5 text-ink-muted">{item.preparationNotes?.map((note) => <li key={note}>• {note}</li>)}</ul></details>}
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${status.tone}`}>{status.label}</span>
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => prepareQueueItem(item)}><Search size={14} />Подготовиться</button>
                <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => void run('open', () => assistant.openVacancy(item.key)).catch(() => undefined)}><ExternalLink size={14} />Открыть</button>
                {actionable && <button type="button" className="btn-primary btn-sm shrink-0" disabled={busy !== ''} onClick={() => void applyQueueItem(item)}>{busy === `apply:${item.key}` ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />}Отправить отклик</button>}
              </div>
            </div>;
          })}
          {visiblePanelCount > visibleLimit && <div className="flex justify-center px-5 py-4"><button type="button" className="btn-secondary btn-sm" onClick={() => setVisibleLimit((limit) => limit + 25)}>Показать ещё · осталось {visiblePanelCount - visibleLimit}</button></div>}
        </div>
      </section>

      {draft.platform === 'hh' && chat && hhConnected && <section id="hh-hr-responses" className="panel-card shrink-0 scroll-mt-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3"><div className={`grid h-10 w-10 place-items-center rounded-full ${chatState?.enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-surface-elevated text-ink-muted'}`}><MessageCircle size={19} /></div><div><h2 className="panel-title">Диалоги HR</h2><p className="text-xs text-ink-faint">{chatState?.enabled ? 'Автоответы включены' : 'Автоответы выключены'}</p></div></div>
          <div className="flex flex-wrap gap-2"><button type="button" className="btn-ghost" onClick={openChatSettings}><Settings2 size={14} />Настройки</button><button type="button" className="btn-ghost" disabled={chatBusy || chatState?.polling} onClick={() => void pollChat()}>{chatBusy || chatState?.polling ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}Проверить сейчас</button></div>
        </div>
        {(chatState?.pendingDecisions.length ?? 0) > 0 && <div className="mt-4 overflow-hidden rounded-xl border border-surface-border bg-surface/25">
          <div className="border-b border-surface-border px-4 py-3"><p className="text-sm font-semibold text-ink">Нужен ответ</p></div>
          <div className="divide-y divide-surface-border">{chatState?.pendingDecisions.map((decision) => <div key={decision.id} className="p-4">
            <p className="text-xs font-semibold text-ink">{decision.vacancyTitle} · {decision.companyName}</p>
            <p className="mt-2 rounded-lg bg-surface-light p-3 text-sm text-ink-muted">HR: {decision.recruiterMessage}</p>
            <label className="mt-3 block"><span className="label">{decision.question}</span><textarea className="field min-h-20 resize-y" value={chatDecisionDrafts[decision.id] ?? chatDecisionSuggestedAnswer(decision.kind)} onChange={(event) => setChatDecisionDrafts((current) => ({ ...current, [decision.id]: event.target.value }))} placeholder="Ваш ответ" /></label>
            <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="btn-primary" disabled={chatBusy} onClick={() => void answerChatDecision(decision.id, true)}><Send size={14} />Отправить и запомнить</button><button type="button" className="btn-ghost" disabled={chatBusy} onClick={() => void answerChatDecision(decision.id, false)}>Отправить один раз</button></div>
          </div>)}</div>
        </div>}
        {((chatState?.repliesToday ?? 0) > 0 || chatState?.lastPollAt) && <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-ink-faint">{chatState?.lastPollAt && <span>Проверено {new Date(chatState.lastPollAt).toLocaleTimeString()}</span>}{(chatState?.repliesToday ?? 0) > 0 && <button type="button" className="font-medium text-sky-300 hover:text-sky-200" onClick={revealReplyHistory}>Ответы сегодня: {chatState?.repliesToday}</button>}</div>}
        {chatPanelError && <p className="mt-3 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs text-red-300">{chatPanelError}</p>}
      </section>}
      </>}
    </div>
  );
}
