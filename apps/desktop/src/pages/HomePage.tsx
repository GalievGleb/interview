import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  EyeOff,
  FileText,
  ListChecks,
  Mic2,
  Send,
  Sparkles,
} from 'lucide-react';
import Modal from '../components/Modal';
import CandidateJourneyStrip from '../components/candidate/CandidateJourneyStrip';
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
  getHomeApplicationFlow,
  isSameLocalDay,
} from '../lib/homeRadar';
import { countUnansweredHhScreeningQuestions, readHhScreeningDrafts, summarizePendingHhScreening } from '../lib/hhScreening';
import { findMatchingQueueItem } from '../lib/interviewBrief';
import { isUpcomingInterview } from '../lib/interviewTiming';
import {
  latestCompleted,
  latestInProgress,
  listSessions,
} from '../lib/vacancyReview/vacancyReviewStore';
import type {
  HhAssistantState,
  HhChatState,
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
  const latestRun = activeRun ?? assistantState?.runHistory[0] ?? null;
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
  const queuedApplications = (assistantState?.queue ?? []).filter(
    (item) => item.status === 'new' || item.status === 'opened' || item.status === 'prepared',
  ).length;
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
  const candidateContextExists = hasVacancy
    || hasResume
    || Boolean(growthProfile.role)
    || hasEvidence;
  const pathChooserVisible = showPathChooser || candidateJourney.path === null;

  const chooseCandidatePath = (path: CandidatePath, destination?: string) => {
    saveCandidatePath(path);
    setCandidatePath(path);
    setShowPathChooser(false);
    navigate(destination ?? (path === 'vacancy' ? '/prepare' : '/documents?mode=baseline'));
  };

  const technicalReadinessPercent = Math.round((preflightReadyCount / preflightChecks.length) * 100);
  const primaryTitle = nearestInterview
    ? `${nearestInterview.companyName} · ${nearestInterview.vacancyTitle}`
    : candidateJourney.headline;
  const primaryBody = nearestInterview
    ? ''
    : candidateJourney.body;
  const primaryAction = nearestInterview
    ? {
        label: vacancyContextReady ? 'Подготовиться' : 'Дополнить вакансию',
        onClick: () => navigate(vacancyContextReady
          ? `/calendar?brief=${encodeURIComponent(nearestInterview.id)}`
          : '/calendar'),
      }
    : { label: candidateJourney.action.label, onClick: () => navigate(candidateJourney.action.to) };
  const queueStatusTitle = activeRun
    ? 'Поиск работает'
    : queuedApplications > 0
      ? 'Очередь продолжится автоматически'
      : latestRun?.status === 'failed'
        ? 'Последний поиск требует проверки'
        : 'Поиск сейчас не запущен';
  const applicationFlow = getHomeApplicationFlow({
    queued: queuedApplications,
    sentToday: sentTodayCount,
    activeDialogs: activeHrDialogs,
    running: Boolean(activeRun),
  });
  const applicationFlowSteps = [
    { key: 'queue', value: queuedApplications, label: 'в очереди' },
    { key: 'sent', value: sentTodayCount, label: 'отправлено сегодня' },
    { key: 'dialogs', value: activeHrDialogs, label: 'диалогов с HR' },
  ];

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
  const showOperationalColumn = candidateContextExists
    || Boolean(latestRun)
    || queuedApplications > 0
    || sentTodayCount > 0
    || activeHrDialogs > 0
    || visibleAttentionItems.length > 0;

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
        <header className="home-radar__heading">
          <div>
            <p className="prep-eyebrow">ВАШ ПУТЬ</p>
            <h1>Ваш следующий шаг</h1>
          </div>
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
            <div className="candidate-path-options">
              <button type="button" className="candidate-path-choice is-primary" onClick={() => chooseCandidatePath('vacancy')}>
                <span><strong>Добавить вакансию</strong><small>Получить персональный разбор</small></span>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
              <button type="button" className="candidate-path-choice" onClick={() => chooseCandidatePath('profile')}>
                <span><strong>Добавить резюме</strong><small>Сохранить факты об опыте</small></span>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
              <button type="button" className="candidate-path-choice" onClick={() => chooseCandidatePath('profile', '/practice')}>
                <span><strong>Начать практику</strong><small>Без конкретной вакансии</small></span>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </div>
          </section>
        ) : (
        <section
          className={`home-radar-grid ${showOperationalColumn && visibleAttentionItems.length === 0 ? 'has-no-attention' : ''}`}
          aria-label="Ваш путь и текущие задачи"
        >
          <article className={`home-radar-primary ${nearestInterview ? 'has-interview' : 'is-priority'} ${showOperationalColumn ? '' : 'is-journey-only'}`}>
            <div className="home-radar-primary__copy">
              <div className="candidate-journey-heading">
                <span>Шаг {candidateJourney.currentStep + 1}</span>
                <button type="button" onClick={() => setShowPathChooser(true)}>Другой сценарий</button>
              </div>
              {nearestInterview ? (
                <span className="home-radar-event-badge">
                  <CalendarClock size={15} aria-hidden="true" />
                  Ближайшее собеседование · {formatHomeInterviewBadge(nearestInterview.startAt, now)}
                </span>
              ) : (
                <span className="home-radar-interview-status">
                  <CalendarClock size={16} aria-hidden="true" />
                  Ближайших собеседований нет
                </span>
              )}
              <h2>{primaryTitle}</h2>
              {nearestInterview && (
                <p className="home-radar-primary__type">{interviewTypeLabel(nearestInterview.type)}</p>
              )}
              {primaryBody && <p className="home-radar-primary__body">{primaryBody}</p>}
              <div className="candidate-journey-actions">
                <button type="button" className="prep-btn" onClick={primaryAction.onClick}>
                  {primaryAction.label}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
                {!nearestInterview && candidateJourney.secondaryAction && (
                  <button
                    type="button"
                    className="prep-btn prep-btn-ghost"
                    onClick={() => navigate(candidateJourney.secondaryAction!.to)}
                  >
                    {candidateJourney.secondaryAction.label}
                  </button>
                )}
              </div>
            </div>

            {nearestInterview && (
              <div
                className="home-radar-score"
                style={{ '--home-radar-score': `${technicalReadinessPercent}%` } as CSSProperties}
                aria-label={`Техническая готовность SkillCue: ${technicalReadinessPercent}%`}
              >
                <div>
                  <strong>{technicalReadinessPercent}%</strong>
                  <span>настройка SkillCue</span>
                  <small>{preflightReadyCount} из {preflightChecks.length}</small>
                </div>
              </div>
            )}
            <CandidateJourneyStrip
              steps={candidateJourney.steps}
              ariaLabel={`Путь: ${candidateJourney.pathLabel}`}
            />
          </article>

          {showOperationalColumn && (
          <>
          <article className="home-radar-panel home-radar-applications">
            <div className="home-radar-panel__heading">
              <span><Send size={16} aria-hidden="true" />Отклики</span>
              <button type="button" onClick={() => navigate('/applications')}>
                Открыть<ArrowUpRight size={14} aria-hidden="true" />
              </button>
            </div>
            <div
              className={`home-radar-flow ${activeRun ? 'is-running' : ''}`}
              aria-label={`Путь откликов: ${queuedApplications} в очереди, ${sentTodayCount} отправлено сегодня, ${activeHrDialogs} диалогов с HR`}
            >
              {applicationFlowSteps.map((step, index) => (
                <div
                  className={`home-radar-flow__step ${applicationFlow.reached[index] ? 'is-reached' : ''}`}
                  key={step.key}
                >
                  <span className="home-radar-flow__node"><strong>{step.value}</strong></span>
                  <small>{step.label}</small>
                </div>
              ))}
            </div>
            <button type="button" className="home-radar-run-state" onClick={() => navigate('/applications')}>
              <span className={activeRun ? 'is-running' : ''} aria-hidden="true" />
              <strong>{queueStatusTitle}</strong>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
            {visibleAttentionItems.length === 0 && (
              <div className="home-radar-automatic-status" role="status">
                <CheckCircle2 size={16} aria-hidden="true" />
                <span>Срочных действий нет</span>
              </div>
            )}
          </article>

          {visibleAttentionItems.length > 0 && (
          <article className="home-radar-panel home-radar-attention">
            <div className="home-radar-panel__heading">
              <span><ListChecks size={16} aria-hidden="true" />Нужно от вас</span>
              <span className="home-radar-count">{attentionItems.length}</span>
            </div>
            <div className="home-radar-actions">
              {visibleAttentionItems.map((item) => (
                <button type="button" key={item.key} onClick={item.onClick}>
                  <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              ))}
            </div>
          </article>
          )}
          </>
          )}
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
