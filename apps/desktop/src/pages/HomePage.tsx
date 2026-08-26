import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  EyeOff,
  FileText,
  ListChecks,
  MessageCircleMore,
  Mic2,
  RefreshCcw,
  Send,
  Sparkles,
} from 'lucide-react';
import Modal from '../components/Modal';
import { useApp } from '../context/AppContext';
import { api, type DevelopmentProfile, type DocumentItem } from '../lib/api';
import {
  buildCandidateJourney,
  readCandidatePath,
  readStoredGrowthProfile,
  saveCandidatePath,
  type CandidatePath,
} from '../lib/candidateJourney';
import {
  formatHomeDate,
  formatHomeInterviewBadge,
  formatHomeInterviewStart,
  getHomeHhCommand,
  getHomeJourneyProgress,
  getHomeQuickActions,
  isInterviewStartingSoon,
  isSameLocalDay,
} from '../lib/homeRadar';
import { countUnansweredHhScreeningQuestions, readHhScreeningDrafts, summarizePendingHhScreening } from '../lib/hhScreening';
import { findMatchingQueueItem } from '../lib/interviewBrief';
import { isUpcomingInterview } from '../lib/interviewTiming';
import { launchLive } from '../lib/launchLive';
import {
  latestCompleted,
  latestInProgress,
  listSessions,
} from '../lib/vacancyReview/vacancyReviewStore';
import type {
  HhAssistantState,
  HhChatState,
  HhQueueItem,
  InterviewCalendarEvent,
  InterviewCalendarState,
} from '../types/electron';

function readPreparationStore() {
  return {
    inProgress: latestInProgress(),
    completed: latestCompleted(),
    sessions: listSessions(),
  };
}

interface CandidateSourceState {
  documents: DocumentItem[];
  hhResumeCount: number;
  profile: DevelopmentProfile | null;
  loading: boolean;
}

function pluralRu(value: number, one: string, few: string, many: string): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function hhVacancyId(value?: string): string {
  return value?.match(/(?:vacancy\/|vacancyId=)(\d+)/i)?.[1] ?? '';
}

export function summarizeHomeHhQueue(queue: readonly HhQueueItem[]) {
  const actionable = queue.filter((item) =>
    item.platform === 'hh'
    && (item.status === 'new' || item.status === 'opened' || item.status === 'prepared'));
  return {
    eligible: actionable.filter((item) => !item.autoRetryBlockedUntil).length,
    daily: actionable.filter((item) => item.autoRetryBlockedUntil === 'daily').length,
    manual: actionable.filter((item) => item.autoRetryBlockedUntil === 'manual').length,
  };
}

function nextInterview(events: InterviewCalendarEvent[], now: Date): InterviewCalendarEvent | undefined {
  return events
    .filter((event) => isUpcomingInterview(event, now))
    .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt))[0];
}

const STEALTH_KEY = 'skillcue.overlayStealth';

function interviewTypeLabel(type: InterviewCalendarEvent['type']): string {
  if (type === 'technical') return 'Техническое собеседование';
  if (type === 'hr') return 'Разговор с HR';
  return 'Собеседование';
}

function HomeApplicationIllustration() {
  return (
    <div className="home-application-illustration" aria-hidden="true">
      <span className="home-application-illustration__spark is-one">✦</span>
      <span className="home-application-illustration__spark is-two">✦</span>
      <span className="home-application-illustration__folder" />
      <span className="home-application-illustration__document is-back">
        <i /><i /><i />
      </span>
      <span className="home-application-illustration__document is-front">
        <i /><i /><i />
      </span>
      <span className="home-application-illustration__check"><CheckCircle2 size={34} /></span>
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const { backendOnline, hasAnyKey, hasStt } = useApp();
  const [store, setStore] = useState(readPreparationStore);
  const [candidatePath, setCandidatePath] = useState<CandidatePath | null>(readCandidatePath);
  const [showPathChooser, setShowPathChooser] = useState(false);
  const [candidateSources, setCandidateSources] = useState<CandidateSourceState>({
    documents: [],
    hhResumeCount: 0,
    profile: null,
    loading: true,
  });
  const [assistantState, setAssistantState] = useState<HhAssistantState | null>(null);
  const [chatState, setChatState] = useState<HhChatState | null>(null);
  const [calendarState, setCalendarState] = useState<InterviewCalendarState | null>(null);
  const [microphoneReady, setMicrophoneReady] = useState<boolean | null>(null);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [homeActionBusy, setHomeActionBusy] = useState(false);
  const [stealthReady, setStealthReady] = useState(() => localStorage.getItem(STEALTH_KEY) === '1');
  const { inProgress, completed, sessions } = store;

  useEffect(() => {
    const refresh = () => setStore(readPreparationStore());
    window.addEventListener('skillcue:mock-sessions-synced', refresh);
    return () => window.removeEventListener('skillcue:mock-sessions-synced', refresh);
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const [documentResult, hhResumes, profile] = await Promise.all([
        api.listDocuments().catch(() => ({ documents: [] as DocumentItem[] })),
        window.electronAPI?.hhAssistant?.getResumes().catch(() => []) ?? Promise.resolve([]),
        api.getDevelopmentProfile().catch(() => null),
      ]);
      if (!active) return;
      setCandidateSources({
        documents: documentResult.documents,
        hhResumeCount: hhResumes.length,
        profile,
        loading: false,
      });
    };
    void refresh();
    window.addEventListener('skillcue:candidate-sources-updated', refresh);
    return () => {
      active = false;
      window.removeEventListener('skillcue:candidate-sources-updated', refresh);
    };
  }, []);

  useEffect(() => {
    const devices = navigator.mediaDevices;
    if (!devices?.enumerateDevices) {
      setMicrophoneReady(false);
      return;
    }
    let active = true;
    const refresh = () => {
      void devices.enumerateDevices()
        .then((items) => { if (active) setMicrophoneReady(items.some((item) => item.kind === 'audioinput')); })
        .catch(() => { if (active) setMicrophoneReady(false); });
    };
    refresh();
    devices.addEventListener?.('devicechange', refresh);
    return () => {
      active = false;
      devices.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  useEffect(() => {
    const assistant = window.electronAPI?.hhAssistant;
    if (!assistant) return;
    let active = true;
    void assistant.getState().then((next) => {
      if (active) setAssistantState(next);
    }).catch(() => {});
    const unsubscribe = assistant.onState((next) => {
      if (active) setAssistantState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const chat = window.electronAPI?.hhChat;
    if (!chat) return;
    let active = true;
    const refresh = () => {
      void chat.getState().then((next) => {
        if (active) setChatState(next);
      }).catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const calendar = window.electronAPI?.interviewCalendar;
    if (!calendar) return;
    let active = true;
    void calendar.getState().then((next) => {
      if (active) setCalendarState(next);
    }).catch(() => {});
    const unsubscribe = calendar.onState((next) => {
      if (active) setCalendarState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const now = new Date();
  const nearestInterview = useMemo(
    () => nextInterview(calendarState?.events ?? [], now),
    // The screen refreshes whenever calendar state changes; minute-level drift is not material here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [calendarState?.events],
  );
  const activeRun = assistantState?.runHistory.find((item) => item.status === 'running') ?? null;
  const screeningSummary = useMemo(
    () => summarizePendingHhScreening(assistantState?.queue ?? []),
    [assistantState?.queue],
  );
  const pendingScreeningVacancies = screeningSummary.vacancies;
  const screeningDrafts = useMemo(() => readHhScreeningDrafts(), []);
  const pendingScreeningQuestions = countUnansweredHhScreeningQuestions(screeningSummary, screeningDrafts);
  const pendingHrDecisions = chatState?.pendingDecisions.length ?? 0;
  const sentTodayCount = (assistantState?.queue ?? []).filter(
    (item) => item.status === 'sent' && item.sentAt && isSameLocalDay(item.sentAt, now),
  ).length;
  const activeHrDialogs = chatState?.activeNegotiations ?? 0;
  const queueGates = summarizeHomeHhQueue(assistantState?.queue ?? []);
  const queuedApplications = queueGates.eligible;
  const manualGateItems = (assistantState?.queue ?? []).filter((item) =>
    item.platform === 'hh'
    && item.autoRetryBlockedUntil === 'manual'
    && (item.status === 'new' || item.status === 'opened' || item.status === 'prepared'));
  const persistentVerificationCount = manualGateItems.filter((item) =>
    /проверк|captcha|капч|не\s+робот|код\s+с\s+картинк/i.test(item.reason ?? '')).length;
  const unknownManualCount = Math.max(0, manualGateItems.length - persistentVerificationCount);
  const serviceReady = backendOnline && hasAnyKey && hasStt;
  const nearestQueueItem = nearestInterview
    ? findMatchingQueueItem(nearestInterview, assistantState?.queue ?? [])
    : null;
  const vacancyContextReady = Boolean(
    nearestInterview && (
      nearestInterview.vacancyUrl?.trim()
      || (nearestInterview.vacancyDescription?.trim().length ?? 0) >= 80
      || nearestQueueItem?.url
      || (nearestQueueItem?.description?.trim().length ?? 0) >= 80
    ),
  );
  const eventContextReady = Boolean(vacancyContextReady && nearestInterview?.meetingUrl?.trim());
  const aiReady = serviceReady && screeningSummary.quotaLimitedCount === 0;
  const preflightChecks = [microphoneReady === true, aiReady, eventContextReady, stealthReady];
  const preflightReadyCount = preflightChecks.filter(Boolean).length;
  const preflightMissing = [
    microphoneReady === true ? '' : 'микрофон',
    aiReady ? '' : screeningSummary.quotaLimitedCount > 0 ? 'лимит ИИ' : 'сервис ИИ',
    eventContextReady ? '' : !vacancyContextReady ? 'вакансия' : 'ссылка на созвон',
    stealthReady ? '' : 'скрытие оверлея',
  ].filter(Boolean);

  const growthProfile = readStoredGrowthProfile();
  const vacancySessions = sessions.filter((session) => session.vacancyAnalysis.contextKind !== 'role');
  const generalPracticeSessions = sessions.filter((session) => session.vacancyAnalysis.contextKind === 'role');
  const hasVacancy = Boolean(nearestInterview)
    || vacancySessions.length > 0
    || candidateSources.documents.some((document) => document.kind === 'vacancy');
  const hasResume = candidateSources.hhResumeCount > 0
    || candidateSources.documents.some((document) => document.kind === 'resume')
    || sessions.some((session) => session.vacancyAnalysis.hasResume);
  const hasEvidence = Boolean(
    completed?.report
    || (candidateSources.profile?.analyzedSessions ?? 0) > 0
    || (candidateSources.profile?.technical.evidenceCount ?? 0) > 0
    || (candidateSources.profile?.hr.evidenceCount ?? 0) > 0,
  );
  const activePreparation = candidatePath === 'vacancy'
    ? vacancySessions.find((session) => session.status === 'in_progress')
      ?? vacancySessions.find((session) => session.status === 'completed')
      ?? vacancySessions[0]
    : inProgress ?? completed ?? generalPracticeSessions[0] ?? sessions[0];
  const activeVacancyId = hhVacancyId(activePreparation?.vacancyAnalysis.vacancyUrl);
  const hasApplication = Boolean(activeVacancyId && (assistantState?.queue ?? []).some((item) =>
    (item.status === 'sent' || item.status === 'already_applied')
    && (item.id === activeVacancyId || hhVacancyId(item.url) === activeVacancyId),
  ));
  const candidateJourney = buildCandidateJourney({
    selectedPath: candidatePath,
    hasVacancy,
    hasResume,
    hasAnalysis: vacancySessions.length > 0,
    practiceAnswers: activePreparation?.status === 'in_progress' ? activePreparation.answers.length : 0,
    practiceQuestions: activePreparation?.status === 'in_progress' ? activePreparation.questions.length : 0,
    practiceCompleted: Boolean(activePreparation?.status === 'completed'),
    hasApplication,
    hasEmployerResponse: activeHrDialogs > 0 || pendingHrDecisions > 0 || Boolean(nearestInterview),
    hasGrowthRole: Boolean(growthProfile.role),
    hasGrowthProfile: Boolean(growthProfile.completed),
    hasEvidence,
    activeSessionId: activePreparation?.id,
    activeVacancyUrl: activePreparation?.vacancyAnalysis.vacancyUrl,
    activeResumeTitle: activePreparation?.vacancyAnalysis.resumeSource?.title,
  });
  const pathChooserVisible = showPathChooser || candidateJourney.path === null;
  const journeyProgress = getHomeJourneyProgress(candidateJourney.steps.map((step) => step.status));
  const quickActions = getHomeQuickActions();
  const newVacancies = assistantState?.lastScanSummary?.newVacancies ?? queuedApplications;
  const repeatedAutomatically = queueGates.daily;
  const resumeReady = candidateSources.documents.length > 0 || candidateSources.hhResumeCount > 0;
  const hhReady = candidateSources.hhResumeCount > 0;

  const chooseCandidatePath = (path: CandidatePath, destination?: string) => {
    saveCandidatePath(path);
    setCandidatePath(path);
    setShowPathChooser(false);
    navigate(destination ?? (path === 'vacancy' ? '/prepare' : '/documents?mode=baseline'));
  };

  const technicalReadinessPercent = Math.round((preflightReadyCount / preflightChecks.length) * 100);
  const hhCommand = getHomeHhCommand({
    running: Boolean(activeRun),
    queued: queuedApplications,
    pendingQuestions: pendingScreeningQuestions,
    loginRequired: Boolean(assistantState?.loginRequired),
    persistentVerification: persistentVerificationCount > 0,
  });
  const interviewStartingSoon = isInterviewStartingSoon(nearestInterview?.startAt, now);
  const homePrimaryLabel = hhCommand.action === 'queue' ? 'Продолжить отклики' : hhCommand.actionLabel;
  const runHomeHhCommand = async () => {
    const assistant = window.electronAPI?.hhAssistant;
    if (hhCommand.action === 'screening') {
      navigate('/applications/hr-profile');
      return;
    }
    if (hhCommand.action === 'queue') {
      navigate('/applications?view=active');
      return;
    }
    if (!assistant) {
      navigate('/applications');
      return;
    }
    setHomeActionBusy(true);
    try {
      const next = hhCommand.action === 'open-hh'
        ? await assistant.openBrowser('hh')
        : await assistant.runNow();
      setAssistantState(next);
    } finally {
      setHomeActionBusy(false);
    }
  };

  const attentionItems: Array<{
    key: string;
    title: string;
    detail: string;
    onClick: () => void;
  }> = [];
  if (pendingHrDecisions > 0) {
    attentionItems.push({
      key: 'hr',
      title: pendingHrDecisions === 1 ? 'Ответить HR' : `Ответить HR · ${pendingHrDecisions}`,
      detail: 'Условия или личные факты, которые нельзя решать за вас',
      onClick: () => navigate('/applications?focus=hr-decisions'),
    });
  }
  if (pendingScreeningVacancies.length > 0) {
    attentionItems.push({
      key: 'screening',
      title: pendingScreeningQuestions > 0
        ? `${pendingScreeningVacancies.length} ${pluralRu(pendingScreeningVacancies.length, 'отклик ждёт', 'отклика ждут', 'откликов ждут')} ответа`
        : 'Ответы готовы к отправке',
      detail: pendingScreeningQuestions > 0
        ? `${pendingScreeningQuestions} ${pluralRu(pendingScreeningQuestions, 'вопрос работодателя', 'вопроса работодателей', 'вопросов работодателей')}; поиск продолжается`
        : 'Проверьте сохранённые ответы и продолжите отклики',
      onClick: () => navigate('/applications/hr-profile'),
    });
  }
  if (queueGates.manual > 0 || (queueGates.daily > 0 && !assistantState?.config.autoRunDaily)) {
    const waiting = queueGates.manual + (assistantState?.config.autoRunDaily ? 0 : queueGates.daily);
    attentionItems.push({
      key: 'queue-gates',
      title: persistentVerificationCount > 0
        ? `${persistentVerificationCount} ${pluralRu(persistentVerificationCount, 'вакансия отложена', 'вакансии отложены', 'вакансий отложены')} после проверки HH`
        : `${waiting} ${pluralRu(waiting, 'отклик повторится', 'отклика повторятся', 'откликов повторятся')}`,
      detail: persistentVerificationCount > 0
        ? 'SkillCue уже обновил страницу три раза; остальные вакансии продолжают обрабатываться'
        : unknownManualCount > 0
          ? 'Незнакомый шаг сохранён отдельно и не останавливает остальную очередь'
        : 'Запустите повтор вручную или включите ежедневный поиск',
      onClick: () => navigate('/applications?view=active'),
    });
  }
  if (nearestInterview && preflightReadyCount < preflightChecks.length) {
    attentionItems.push({
      key: 'readiness',
      title: 'Настроить SkillCue к созвону',
      detail: `Проверить: ${preflightMissing.join(', ')}`,
      onClick: () => setReadinessOpen(true),
    });
  } else if (!serviceReady || screeningSummary.quotaLimitedCount > 0) {
    attentionItems.push({
      key: 'service',
      title: screeningSummary.quotaLimitedCount > 0 ? 'Восстановить онлайн-ИИ' : 'Проверить сервис ИИ',
      detail: screeningSummary.quotaLimitedCount > 0
        ? 'Сохранённые факты работают, новые онлайн-черновики ограничены'
        : 'Проверьте backend, ключ и распознавание речи',
      onClick: () => navigate(screeningSummary.quotaLimitedCount > 0 ? '/settings?tab=billing' : '/settings'),
    });
  }
  const visibleAttentionItems = attentionItems.slice(0, 3);
  const closeReadinessAndNavigate = (path: string) => {
    setReadinessOpen(false);
    navigate(path);
  };
  const enableStealthMode = () => {
    localStorage.setItem(STEALTH_KEY, '1');
    setStealthReady(true);
    void window.electronAPI?.overlay.setContentProtection?.(true);
  };
  const aiReadinessDetail = !backendOnline
    ? 'Локальный сервис SkillCue не отвечает. Перезапустите приложение; если статус не изменится — откройте настройки тарифа.'
    : !hasAnyKey
      ? 'Не активирован тариф или ключ онлайн-ИИ.'
      : !hasStt
        ? 'Не настроено распознавание речи для созвона.'
        : screeningSummary.quotaLimitedCount > 0
          ? 'Месячный лимит онлайн-ИИ исчерпан. Новые подсказки заработают после обновления лимита или активации большего тарифа.'
          : 'Онлайн-подсказки и распознавание готовы.';
  const aiActionPath = !hasStt && hasAnyKey ? '/settings?tab=speech' : '/settings?tab=billing';
  const missingEventContext = [
    vacancyContextReady ? '' : 'требования вакансии',
    nearestInterview?.meetingUrl?.trim() ? '' : 'ссылка на встречу',
  ].filter(Boolean);
  const readinessSteps = nearestInterview ? [
    {
      key: 'microphone',
      title: 'Микрофон',
      detail: microphoneReady === true
        ? 'Устройство найдено. Перед созвоном можно проверить уровень сигнала.'
        : 'Откройте проверку, разрешите доступ и убедитесь, что шкала реагирует на голос.',
      ready: microphoneReady === true,
      icon: <Mic2 size={18} aria-hidden="true" />,
      actionLabel: 'Проверить',
      onClick: () => closeReadinessAndNavigate('/settings?tab=speech'),
    },
    {
      key: 'ai',
      title: 'Онлайн-ИИ и распознавание',
      detail: aiReadinessDetail,
      ready: aiReady,
      icon: <Sparkles size={18} aria-hidden="true" />,
      actionLabel: !hasStt && hasAnyKey ? 'Настроить речь' : 'Открыть тариф',
      onClick: () => closeReadinessAndNavigate(aiActionPath),
    },
    {
      key: 'event',
      title: 'Данные собеседования',
      detail: eventContextReady
        ? 'Требования вакансии и ссылка на встречу сохранены.'
        : `Не хватает: ${missingEventContext.join(' и ')}. Откроется сразу форма именно этого созвона.`,
      ready: eventContextReady,
      icon: <FileText size={18} aria-hidden="true" />,
      actionLabel: 'Добавить данные',
      onClick: () => closeReadinessAndNavigate(`/calendar?edit=${encodeURIComponent(nearestInterview.id)}`),
    },
    {
      key: 'stealth',
      title: 'Скрытие оверлея',
      detail: stealthReady
        ? 'Окно подсказок защищено от демонстрации экрана.'
        : 'Включите защиту, чтобы оверлей не попал в трансляцию экрана.',
      ready: stealthReady,
      icon: <EyeOff size={18} aria-hidden="true" />,
      actionLabel: 'Включить',
      onClick: enableStealthMode,
    },
  ] : [];

  return (
    <>
      <div className="prep h-full overflow-y-auto">
        <div className="prep-wrap home-radar prep-rise">
        <header className="home-radar__heading home-dashboard-heading">
          <h1 className="sr-only">Главная SkillCue</h1>
          <p className="home-radar-date">
            <CalendarClock size={16} aria-hidden="true" />
            <span>{formatHomeDate(now)}</span>
          </p>
        </header>

        {pathChooserVisible ? (
          <section
            className="candidate-path-entry"
            aria-labelledby="candidate-path-title"
            aria-busy={candidateSources.loading}
          >
            <div className="candidate-path-entry__intro">
              <p className="prep-eyebrow">ОТПРАВНАЯ ТОЧКА</p>
              <h2 id="candidate-path-title">С чего начать?</h2>
            </div>
            <div
              className={`candidate-path-options ${candidateSources.loading ? 'animate-pulse opacity-60 pointer-events-none' : ''}`}
              aria-hidden={candidateSources.loading || undefined}
            >
              <button type="button" className={`candidate-path-choice ${!resumeReady ? 'is-primary' : ''}`} onClick={() => chooseCandidatePath('profile')}>
                <span><strong>{resumeReady ? 'Резюме добавлено' : 'Добавить резюме'}</strong><small>Основа персональных ответов и подготовки</small></span>
                {resumeReady ? <CheckCircle2 size={17} aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
              </button>
              <button type="button" className={`candidate-path-choice ${resumeReady && !hhReady ? 'is-primary' : ''}`} onClick={() => navigate('/applications?mode=settings')}>
                <span><strong>{hhReady ? 'HH подключён' : 'Подключить HH'}</strong><small>Автоматический поиск и отклики</small></span>
                {hhReady ? <CheckCircle2 size={17} aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
              </button>
              <button type="button" className={`candidate-path-choice ${resumeReady && hhReady ? 'is-primary' : ''}`} onClick={() => launchLive(() => navigate('/overlay'))}>
                <span><strong>Запустить оверлей</strong><small>Подсказки во время собеседования</small></span>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </div>
          </section>
        ) : (
        <section
          className={`home-command-center ${interviewStartingSoon ? 'has-urgent-interview' : ''}`}
          aria-label="Автоотклики и ближайшее собеседование"
        >
          <article className="home-command-hero">
            <div className="home-command-hero__top">
              <span className="home-command-kicker"><b className="home-command-service-icon">hh</b>АВТООТКЛИКИ HH</span>
              <button type="button" className="home-command-link" onClick={() => navigate('/applications')}>
                Все отклики<ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="home-command-hero__body">
              <div className="home-command-hero__copy">
                <p className="home-command-eyebrow">{hhCommand.eyebrow}</p>
                <h2>{hhCommand.title}</h2>
                <p>
                  {pendingScreeningQuestions > 0
                    ? 'SkillCue уже подготовил подходящие ответы. Нужны только неизвестные личные факты.'
                    : activeRun
                      ? 'Новые вакансии проверяются по выбранному резюме; очередь продолжает работу в фоне.'
                      : 'Все отклики и ответы работодателей — в одном месте.'}
                </p>
              </div>
              <HomeApplicationIllustration />
            </div>
            <div className="home-command-stats" aria-label="Состояние откликов">
              <div><strong>{newVacancies}</strong><span>новые вакансии</span></div>
              <div><strong>{sentTodayCount}</strong><span>откликов отправлено</span></div>
              <div><strong>{activeHrDialogs}</strong><span>ответов от HR</span></div>
              {repeatedAutomatically > 0 && (
                <p className="home-command-repeat"><RefreshCcw size={14} />{repeatedAutomatically} повторятся автоматически</p>
              )}
            </div>
            {(queueGates.daily > 0 || persistentVerificationCount > 0 || unknownManualCount > 0) && (
              <div className="home-command-barriers">
                {queueGates.daily > 0 && <span>{queueGates.daily} повторятся автоматически</span>}
                {persistentVerificationCount > 0 && <span>{persistentVerificationCount} отложены после трёх проверок HH</span>}
                {unknownManualCount > 0 && <span>{unknownManualCount} остановлены на незнакомом шаге</span>}
              </div>
            )}
            <div className="home-command-actions">
              <button type="button" className="home-command-cta" disabled={homeActionBusy} onClick={() => void runHomeHhCommand()}>
                {homeActionBusy ? 'Запускаю…' : homePrimaryLabel}<ArrowRight size={17} aria-hidden="true" />
              </button>
              <button type="button" className="home-command-secondary" onClick={() => setShowPathChooser(true)}>Изменить путь</button>
            </div>
            <button type="button" className="home-command-progress" onClick={() => navigate(candidateJourney.action.to)}>
              <span><i />{journeyProgress > 0 ? 'Вы на пути к цели' : 'Начните путь к цели'}</span>
              <b><i style={{ width: `${journeyProgress}%` }} /></b>
              <em>{journeyProgress}%</em>
              <ChevronRight size={18} />
            </button>
          </article>

          <aside className="home-command-side">
            <article className={`home-command-interview ${interviewStartingSoon ? 'is-urgent' : ''}`}>
              <div className="home-command-card__heading">
                <span><CalendarClock size={16} aria-hidden="true" />Собеседование</span>
                {nearestInterview && <b>{formatHomeInterviewBadge(nearestInterview.startAt, now)}</b>}
              </div>
              {nearestInterview ? (
                <>
                  <h3>{nearestInterview.companyName} · {nearestInterview.vacancyTitle}</h3>
                  <p>{interviewTypeLabel(nearestInterview.type)} · готовность SkillCue {technicalReadinessPercent}%</p>
                  <button type="button" onClick={() => navigate(vacancyContextReady ? `/calendar?brief=${encodeURIComponent(nearestInterview.id)}` : `/calendar?edit=${encodeURIComponent(nearestInterview.id)}`)}>
                    {vacancyContextReady ? 'Подготовиться' : 'Добавить данные'}<ArrowRight size={15} />
                  </button>
                </>
              ) : (
                <>
                  <h3>Ближайших собеседований нет</h3>
                  <p>Когда появится встреча, она станет главной за два часа до начала.</p>
                  <button type="button" onClick={() => navigate('/calendar')}>Открыть календарь<ArrowRight size={15} /></button>
                </>
              )}
            </article>

            {visibleAttentionItems.length > 0 ? (
              <article className="home-command-attention">
                <div className="home-command-card__heading"><span><ListChecks size={16} />Нужно от вас</span><b>{attentionItems.length}</b></div>
                <div className="home-command-attention__list">
                  {visibleAttentionItems.map((item) => (
                    <button type="button" key={item.key} onClick={item.onClick}>
                      <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
              </article>
            ) : (
              <div className="home-command-clear" role="status"><CheckCircle2 size={16} /><span>Срочных действий нет</span></div>
            )}

            <article className="home-command-quick-actions">
              <h3>Быстрые действия</h3>
              <div>
                {quickActions.map((action) => {
                  const Icon = action.id === 'vacancies'
                    ? Send
                    : action.id === 'resume'
                      ? FileText
                      : MessageCircleMore;
                  return (
                    <button type="button" key={action.id} onClick={() => navigate(action.to)}>
                      <span className="home-command-quick-actions__icon"><Icon size={18} /></span>
                      <span><strong>{action.label}</strong><small>{action.detail}</small></span>
                      <ChevronRight size={17} />
                    </button>
                  );
                })}
              </div>
            </article>
          </aside>
        </section>
        )}
        </div>
      </div>

      <Modal
        open={readinessOpen && Boolean(nearestInterview)}
        onClose={() => setReadinessOpen(false)}
        title={`Техническая готовность SkillCue — ${technicalReadinessPercent}%`}
        subtitle={nearestInterview ? `${nearestInterview.companyName} · ${nearestInterview.vacancyTitle} · ${formatHomeInterviewStart(nearestInterview.startAt, now)}` : undefined}
        size="lg"
        footer={<button type="button" className="btn-secondary" onClick={() => setReadinessOpen(false)}>Закрыть</button>}
      >
        <p className="home-readiness-intro">
          Это проверка техники и контекста, а не оценка ваших знаний. Выполните только пункты «Нужно сделать» — готовые настройки повторять не придётся.
        </p>
        <div className="home-readiness-list">
          {readinessSteps.map((step, index) => (
            <article className={`home-readiness-step ${step.ready ? 'is-ready' : ''}`} key={step.key}>
              <span className="home-readiness-step__number">{step.ready ? <CheckCircle2 size={18} /> : index + 1}</span>
              <span className="home-readiness-step__icon">{step.icon}</span>
              <span className="home-readiness-step__copy">
                <strong>{step.title}</strong>
                <small>{step.detail}</small>
              </span>
              {step.ready
                ? <span className="home-readiness-step__status">Готово</span>
                : <button type="button" className="btn-secondary btn-sm" onClick={step.onClick}>{step.actionLabel}</button>}
            </article>
          ))}
        </div>
      </Modal>
    </>
  );
}
