import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type SessionAssessment } from '../lib/api';
import { useLiveCopilot } from '../hooks/useLiveCopilot';
import { useLiveCopilotPrefs } from '../hooks/useLiveCopilotPrefs';
import { useApp } from '../context/AppContext';
import type { TranscriptLine } from '../hooks/useLiveCopilot';
import MarkdownText from '../components/MarkdownText';
import OverlayTooltipLayer from '../components/OverlayTooltipLayer';
import { forceDarkTheme } from '../lib/theme';
import { modeInstructionPrefix, useAnswerModes } from '../lib/answerModes';
import { deriveLiveExchange } from '../lib/liveOverlaySync';
import {
  acceptForceHotkey,
  type ForceHotkeyEvent,
  type ForceHotkeySource,
} from '../lib/forceHotkeyDeduper';
import {
  resolveOverlayRequestRoute,
  type OverlayActionId,
} from '../lib/overlayRequestRoute';
import {
  OverlayPointerController,
  clampFloatingPanel,
} from '../lib/overlayPointerPolicy';
import { useI18n, type I18nKey } from '../lib/i18n';
import { refreshSessionKnowledge } from '../lib/sessionKnowledge';
import { answerLanguageParam } from '../lib/answerLanguage';

/**
 * Плавающий оверлей SkillCue (вдохновлён Cluely, но в навы+зелёном стиле):
 * — пилл сверху: логотип (открывает приложение), «Скрыть» с дропдауном, запись;
 * — командная панель: Подсказка · Что сказать? · Доп. вопросы · Резюме · Экран,
 *   поле ввода (Ctrl+Enter = Подсказка), Smart, меню «…» с keybinds/тумблерами;
 * — панель ответа: синий пузырь запроса + стримящийся ответ + копирование;
 * — экран итогов сессии (Summary / Transcript / Usage) при остановке записи.
 * Undetectability прячет оверлей от скринов/записи и рисует пунктирную обводку.
 */

type ActionId = OverlayActionId;

const ACTIONS: Record<
  ActionId,
  { labelKey: I18nKey; tipKey: I18nKey; needsContext: boolean; prompt: string }
> = {
  assist: {
    labelKey: 'overlay.action.assist',
    tipKey: 'overlay.tip.assist',
    needsContext: false,
    prompt:
      'Помоги ответить на последний вопрос интервьюера из разговора. Дай готовый ответ от первого лица, чтобы произнести вслух: 40–80 слов, по делу, без вступлений.',
  },
  say: {
    labelKey: 'overlay.action.say',
    tipKey: 'overlay.tip.say',
    needsContext: true,
    prompt:
      'Подскажи, что мне сказать прямо сейчас, учитывая ход разговора. Готовая фраза/мини-ответ от первого лица, максимум 60 слов.',
  },
  followup: {
    labelKey: 'overlay.action.followup',
    tipKey: 'overlay.tip.followup',
    needsContext: true,
    prompt:
      'Какие уточняющие вопросы, скорее всего, задаст интервьюер после моего последнего ответа? Дай 3–5 вопросов и к каждому — краткую подсказку, как отвечать.',
  },
  recap: {
    labelKey: 'overlay.action.recap',
    tipKey: 'overlay.tip.recap',
    needsContext: true,
    prompt:
      'Сделай краткое резюме разговора: какие темы подняли, что я ответил, какие вопросы остались открытыми. 3–6 пунктов.',
  },
  screen: {
    labelKey: 'overlay.action.screen',
    tipKey: 'overlay.tip.screen',
    needsContext: false,
    prompt: '', // vision-путь: скриншот + вопрос, см. runAction
  },
};

const SMART_KEY = 'skillcue.overlaySmart';
const STEALTH_KEY = 'skillcue.overlayStealth';
const AVOID_FOCUS_KEY = 'skillcue.overlayAvoidFocus';
const HIDE_WIDGET_KEY = 'skillcue.overlayHideWidget';
const USE_SCREEN_KEY = 'skillcue.overlayUseScreen';
const OPACITY_KEY = 'skillcue.overlayOpacity';

function clampOpacity(v: number): number {
  return Number.isFinite(v) && v >= 40 && v <= 100 ? v : 100;
}

type RecapTab = 'summary' | 'analysis' | 'transcript' | 'usage';

interface RecapSnapshot {
  lines: TranscriptLine[];
  at: number;
  sessionId: string | null;
}

interface Exchange {
  label: string;
  request: string;
  text: string;
  streaming: boolean;
  /** Скриншот, который ушёл модели (для превью «Смотрел экран»). */
  image?: string;
}

/** Один завершённый ручной обмен — для вкладки Usage в итогах сессии. */
interface UsageEntry {
  label: string;
  request: string;
  text: string;
  image?: string;
}

function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {d.split('|').map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

/** Мини-переключатель в навы+зелёном стиле (как тумблеры в меню Cluely). */
function Switch({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`ovl-switch ${on ? 'ovl-switch--on' : ''}`}
    >
      <span className="ovl-switch-knob" />
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="overlay-icon-btn tip flex items-center gap-1.5 text-[12px]"
      data-tip={copied ? t('overlay.copiedTick') : t('overlay.copy')}
      aria-label={t('overlay.copy')}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? (
        <Icon d="M20 6 9 17l-5-5" />
      ) : (
        <Icon d="M8 8h12v12H8z|M16 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" />
      )}
      {label && <span>{copied ? t('overlay.copied') : label}</span>}
    </button>
  );
}

function buildTranscript(ls: TranscriptLine[], me: string, other: string): string {
  return ls
    .filter((l) => l.isFinal)
    .map((l) => `${l.speaker === 'me' ? me : other}: ${l.text}`)
    .join('\n');
}

export default function OverlayPage() {
  const { t, lang } = useI18n();
  const { hasStt } = useApp();
  const {
    active,
    lines,
    answerHistory,
    currentQuestion,
    streamText,
    streaming,
    forceGeneration,
    forcePhase,
    forceScreenFallbackGeneration,
    error,
    sessionId,
    forceAnswer,
    start,
    stop,
  } = useLiveCopilot();
  const { sources, sttOptions, setSources } = useLiveCopilotPrefs();

  const [input, setInput] = useState('');
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [smart, setSmart] = useState(() => localStorage.getItem(SMART_KEY) === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const [hideMenuOpen, setHideMenuOpen] = useState(false);
  const [modesOpen, setModesOpen] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [notice, setNotice] = useState('');
  const { modes, active: activeMode, setActive: setActiveMode } = useAnswerModes();

  // Cluely-подобные тумблеры.
  const [stealth, setStealth] = useState(() => localStorage.getItem(STEALTH_KEY) === '1');
  const [avoidFocus, setAvoidFocus] = useState(() => localStorage.getItem(AVOID_FOCUS_KEY) === '1');
  const [hideHidesWidget, setHideHidesWidget] = useState(
    () => localStorage.getItem(HIDE_WIDGET_KEY) !== '0',
  );
  const [opacity, setOpacity] = useState(() =>
    clampOpacity(Number(localStorage.getItem(OPACITY_KEY))),
  );
  const [collapsed, setCollapsed] = useState(false);

  // Итоги сессии.
  const [usageLog, setUsageLog] = useState<UsageEntry[]>([]);
  const [recap, setRecap] = useState<RecapSnapshot | null>(null);
  const [recapTab, setRecapTab] = useState<RecapTab>('summary');
  const [recapSummary, setRecapSummary] = useState('');
  const [recapSummaryStreaming, setRecapSummaryStreaming] = useState(false);
  const [analysis, setAnalysis] = useState<SessionAssessment | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');

  const cancelRef = useRef<(() => void) | null>(null);
  const summaryCancelRef = useRef<(() => void) | null>(null);
  const analysisRequestGenerationRef = useRef(0);
  const screenAssistGenerationRef = useRef(0);
  const forceScreenFallbackOwnerRef = useRef(0);
  const manualBusyRef = useRef(false);
  const lastForceScreenFallbackRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const hideMenuRef = useRef<HTMLDivElement>(null);
  const answerBodyRef = useRef<HTMLDivElement>(null);
  const lastForceHotkeyRef = useRef<ForceHotkeyEvent | null>(null);
  const pointerControllerRef = useRef<OverlayPointerController | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });

  // Прозрачный фон окна: панели «плавают» над рабочим столом.
  // Оверлей всегда тёмный, независимо от темы приложения.
  useEffect(() => {
    forceDarkTheme();
    const prevBody = document.body.style.background;
    const prevHtml = document.documentElement.style.background;
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    return () => {
      document.body.style.background = prevBody;
      document.documentElement.style.background = prevHtml;
    };
  }, []);

  // Тумблеры могли переключить в настройках (другое окно) — синхронизируемся.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STEALTH_KEY) setStealth(e.newValue === '1');
      if (e.key === HIDE_WIDGET_KEY) setHideHidesWidget(e.newValue !== '0');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Применяем сохранённые Undetectability / «не забирать фокус» при запуске.
  useEffect(() => {
    void window.electronAPI?.overlay.setContentProtection?.(stealth);
    void window.electronAPI?.overlay.setFocusable?.(!avoidFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // «Работать под панелью»: при «не забирать фокус» делаем оверлей click-through —
  // клики уходят в приложение под ним, панель не перехватывает мышь. При
  // наведении курсора на интерактив оверлея временно возвращаем ему мышь
  // (Electron forward:true шлёт mousemove, даже когда клики игнорируются).
  useEffect(() => {
    const ct = window.electronAPI?.overlay.setClickThrough;
    if (!ct) return;
    const controller = new OverlayPointerController(
      (enabled) => void ct(enabled),
      (x, y) => document.elementFromPoint(x, y),
    );
    pointerControllerRef.current = controller;
    controller.initialize();
    const onMove = (e: MouseEvent) => {
      controller.move(e.clientX, e.clientY);
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (pointerControllerRef.current === controller) pointerControllerRef.current = null;
      controller.dispose();
    };
  }, []);

  // Opening or removing a card/menu changes the hit region under a stationary
  // cursor. Refresh after every committed layout so the next click cannot be
  // swallowed by a surface that is no longer visible.
  useLayoutEffect(() => {
    pointerControllerRef.current?.refresh();
  });

  useEffect(
    () => () => {
      screenAssistGenerationRef.current += 1;
      cancelRef.current?.();
      summaryCancelRef.current?.();
    },
    [],
  );

  const transcriptContext = useCallback((): string => {
    const recent = lines.slice(-30).filter((l) => l.isFinal);
    return recent
      .map((l) => `${l.speaker === 'me' ? t('overlay.me') : t('overlay.interviewer')}: ${l.text}`)
      .join('\n');
  }, [lines, t]);

  const runScreenAssist = useCallback(
    async (customText: string, mode: 'general' | 'deep') => {
      const requestGeneration = ++screenAssistGenerationRef.current;
      const capture = window.electronAPI?.overlay.captureScreen;
      if (!capture) {
        setNotice(t('overlay.screenOnlyDesktop'));
        return;
      }
      setNotice('');
      cancelRef.current?.();
      cancelRef.current = null;
      manualBusyRef.current = true;
      const request = customText || t('overlay.whatOnScreen');
      setExchange({ label: t('overlay.action.screen'), request, text: '', streaming: true });
      setInput('');

      const image = await capture().catch(() => '');
      if (requestGeneration !== screenAssistGenerationRef.current) return;
      if (!image) {
        manualBusyRef.current = false;
        setExchange(null);
        setNotice(t('overlay.screenshotFailed'));
        return;
      }
      setExchange((prev) => (prev ? { ...prev, image } : prev));

      let acc = '';
      cancelRef.current = api.streamScreenAssist(
        image,
        `${modeInstructionPrefix()}${customText}`.trim(),
        {
          onChunk: (t) => {
            if (requestGeneration !== screenAssistGenerationRef.current) return;
            acc += t;
            setExchange((prev) => (prev ? { ...prev, text: prev.text + t } : prev));
          },
          onDone: () => {
            if (requestGeneration !== screenAssistGenerationRef.current) return;
            cancelRef.current = null;
            manualBusyRef.current = false;
            setExchange((prev) => (prev ? { ...prev, streaming: false } : prev));
            setUsageLog((log) => [...log, { label: t('overlay.action.screen'), request, text: acc, image }]);
          },
          onError: (msg) => {
            if (requestGeneration !== screenAssistGenerationRef.current) return;
            cancelRef.current = null;
            manualBusyRef.current = false;
            setExchange((prev) =>
              prev ? { ...prev, streaming: false, text: prev.text || `⚠ ${msg}` } : prev,
            );
          },
        },
        {
          context: transcriptContext() || undefined,
          mode,
        },
      );
    },
    [transcriptContext, t],
  );

  const runAction = useCallback(
    (id: ActionId, customText?: string) => {
      const action = ACTIONS[id];
      const context = transcriptContext();
      const custom = (customText ?? '').trim();

      const route = resolveOverlayRequestRoute({
        action: id,
        customText: custom,
        hasTranscript: Boolean(context),
        canCaptureScreen: Boolean(window.electronAPI?.overlay.captureScreen),
        useScreenFallback: localStorage.getItem(USE_SCREEN_KEY) !== '0',
        smart,
      });

      if (route.kind === 'screen') {
        void runScreenAssist(custom, route.mode);
        return;
      }

      if (route.kind === 'notice') {
        screenAssistGenerationRef.current += 1;
        setNotice(action.needsContext ? t('overlay.noConvContext') : t('overlay.noConvManual'));
        return;
      }
      screenAssistGenerationRef.current += 1;
      setNotice('');
      cancelRef.current?.();
      manualBusyRef.current = true;

      // Инструкция активного режима (см. Настройки → Режимы ответа).
      const message =
        modeInstructionPrefix() +
        (custom
          ? `${custom}${context ? '\n\n(Отвечай с учётом текущего разговора.)' : ''}`
          : action.prompt);
      const request = custom || t(action.labelKey);

      setExchange({ label: t(action.labelKey), request, text: '', streaming: true });
      setInput('');

      let acc = '';
      cancelRef.current = api.streamChat(
        message,
        {
          onChunk: (t) => {
            acc += t;
            setExchange((prev) => (prev ? { ...prev, text: prev.text + t } : prev));
          },
          onDone: () => {
            manualBusyRef.current = false;
            setExchange((prev) => (prev ? { ...prev, streaming: false } : prev));
            setUsageLog((log) => [...log, { label: t(action.labelKey), request, text: acc }]);
          },
          onError: (msg) => {
            manualBusyRef.current = false;
            setExchange((prev) =>
              prev ? { ...prev, streaming: false, text: prev.text || `⚠ ${msg}` } : prev,
            );
          },
        },
        {
          mode: route.mode,
          context: context || undefined,
        },
      );
    },
    [runScreenAssist, smart, transcriptContext, t],
  );

  // Live-ответы (авто) — в ту же панель, пока нет ручного запроса.
  const lastEntry = answerHistory[answerHistory.length - 1];
  useEffect(() => {
    if (!forceScreenFallbackGeneration) {
      lastForceScreenFallbackRef.current = 0;
      return;
    }
    if (lastForceScreenFallbackRef.current === forceScreenFallbackGeneration) return;
    lastForceScreenFallbackRef.current = forceScreenFallbackGeneration;
    forceScreenFallbackOwnerRef.current = forceScreenFallbackGeneration;
    void runScreenAssist('', smart ? 'deep' : 'general');
  }, [forceScreenFallbackGeneration, runScreenAssist, smart]);

  const cancelOwnedForceScreenFallback = useCallback((generation: number) => {
    if (!generation || forceScreenFallbackOwnerRef.current !== generation) return;
    forceScreenFallbackOwnerRef.current = 0;
    screenAssistGenerationRef.current += 1;
    cancelRef.current?.();
    cancelRef.current = null;
    manualBusyRef.current = false;
  }, []);

  useEffect(() => {
    if (forcePhase === 'waiting-first-token' || forcePhase === 'streaming') {
      cancelOwnedForceScreenFallback(forceGeneration);
    }
  }, [cancelOwnedForceScreenFallback, forceGeneration, forcePhase]);

  useEffect(() => {
    if (!forceGeneration) return;
    if (forcePhase === 'finalizing-transcript' || forcePhase === 'waiting-first-token') {
      setExchange({
        label: 'Live',
        request: currentQuestion || t('overlay.forceRequest'),
        text: '',
        streaming: true,
      });
    }
  }, [forceGeneration, forcePhase, currentQuestion, t]);

  useEffect(() => {
    if (manualBusyRef.current) return;
    if (forcePhase === 'error' && !error) return;
    const forcedError = forcePhase === 'error' ? error : '';
    const view = deriveLiveExchange(
      streamText,
      streaming,
      lastEntry?.spoken,
      forcePhase,
      forcedError,
    );
    if (!view.show) return;
    const forcedCard =
      forcePhase === 'finalizing-transcript' ||
      forcePhase === 'waiting-first-token' ||
      forcePhase === 'streaming' ||
      forcePhase === 'error';
    const question =
      currentQuestion ||
      (forcedCard ? t('overlay.forceRequest') : lastEntry?.question) ||
      t('overlay.interviewerQuestion');
    const pending =
      streaming ||
      forcePhase === 'finalizing-transcript' ||
      forcePhase === 'waiting-first-token' ||
      forcePhase === 'streaming';
    setExchange({ label: 'Live', request: question, text: view.text, streaming: pending });
  }, [
    streamText,
    streaming,
    forceGeneration,
    forcePhase,
    lastEntry?.id,
    lastEntry?.spoken,
    lastEntry?.question,
    currentQuestion,
    error,
    t,
  ]);

  const toggleSmart = () => {
    const next = !smart;
    setSmart(next);
    localStorage.setItem(SMART_KEY, next ? '1' : '0');
  };

  const closeExchange = useCallback(() => {
    forceScreenFallbackOwnerRef.current = 0;
    screenAssistGenerationRef.current += 1;
    cancelRef.current?.();
    cancelRef.current = null;
    manualBusyRef.current = false;
    setExchange(null);
  }, []);

  // ---------- Итоги сессии ----------
  const generateSummary = useCallback((ls: TranscriptLine[]) => {
    const transcript = buildTranscript(ls, t('overlay.me'), t('overlay.interviewer'));
    summaryCancelRef.current?.();
    if (!transcript) {
      setRecapSummary(t('overlay.summaryTooShort'));
      setRecapSummaryStreaming(false);
      return;
    }
    setRecapSummary('');
    setRecapSummaryStreaming(true);
    summaryCancelRef.current = api.streamMeetingSummary(
      transcript,
      {
        onChunk: (c) => setRecapSummary((s) => s + c),
        onDone: () => setRecapSummaryStreaming(false),
        onError: (m) => {
          setRecapSummaryStreaming(false);
          setRecapSummary((s) => s || `⚠ ${m}`);
        },
      },
      { answerLanguage: (answerLanguageParam() ?? lang) as 'ru' | 'en' },
    );
  }, [lang, t]);

  const requestRecapAnalysis = useCallback(async (requestSessionId: string) => {
    const requestGeneration = ++analysisRequestGenerationRef.current;
    setAnalysisLoading(true);
    setAnalysisError('');
    try {
      const analysisLanguage = (answerLanguageParam() ?? lang) as 'ru' | 'en';
      const result = await api.createSessionAnalysis(requestSessionId, analysisLanguage);
      void refreshSessionKnowledge().catch(() => {
        // The assessment itself is already persisted; cache refresh is best-effort.
      });
      if (requestGeneration !== analysisRequestGenerationRef.current) return;
      setAnalysis(result);
    } catch (err) {
      if (requestGeneration !== analysisRequestGenerationRef.current) return;
      setAnalysisError(
        err instanceof Error && err.message.trim()
          ? err.message
          : t('overlay.recap.analysisFailed'),
      );
    } finally {
      if (requestGeneration === analysisRequestGenerationRef.current) {
        setAnalysisLoading(false);
      }
    }
  }, [lang, t]);

  const openRecap = useCallback(
    (snapshot: TranscriptLine[], endedSessionId: string | null) => {
      analysisRequestGenerationRef.current += 1;
      setRecap({ lines: snapshot, at: Date.now(), sessionId: endedSessionId });
      setRecapTab(endedSessionId ? 'analysis' : 'summary');
      setAnalysis(null);
      setAnalysisError('');
      setAnalysisLoading(false);
      generateSummary(snapshot);
      if (endedSessionId) void requestRecapAnalysis(endedSessionId);
    },
    [generateSummary, requestRecapAnalysis],
  );

  const closeRecap = useCallback(() => {
    analysisRequestGenerationRef.current += 1;
    summaryCancelRef.current?.();
    setRecap(null);
    setRecapSummary('');
    setRecapSummaryStreaming(false);
    setAnalysis(null);
    setAnalysisError('');
    setAnalysisLoading(false);
  }, []);

  const stopSession = useCallback(() => {
    if (!active) return;
    const snapshot = lines.slice();
    const endedSessionId = sessionId;
    void stop().then(() => {
      if (snapshot.some((l) => l.isFinal)) openRecap(snapshot, endedSessionId);
    });
  }, [active, lines, sessionId, stop, openRecap]);

  const analyzeRecap = useCallback(async () => {
    if (!recap?.sessionId) {
      setAnalysisError(t('overlay.recap.analysisUnavailable'));
      return;
    }

    await requestRecapAnalysis(recap.sessionId);
  }, [recap, requestRecapAnalysis, t]);

  const toggleSession = () => {
    if (active) stopSession();
    else {
      closeRecap();
      setUsageLog([]);
      void start(sources, sttOptions);
    }
  };

  const resumeFromRecap = () => {
    closeRecap();
    void start(sources, sttOptions);
  };

  // ---------- Тумблеры ----------
  const toggleStealth = () => {
    const next = !stealth;
    setStealth(next);
    localStorage.setItem(STEALTH_KEY, next ? '1' : '0');
    void window.electronAPI?.overlay.setContentProtection?.(next);
  };

  const toggleAvoidFocus = () => {
    const next = !avoidFocus;
    setAvoidFocus(next);
    localStorage.setItem(AVOID_FOCUS_KEY, next ? '1' : '0');
    void window.electronAPI?.overlay.setFocusable?.(!next);
  };

  const toggleHideHidesWidget = () => {
    const next = !hideHidesWidget;
    setHideHidesWidget(next);
    localStorage.setItem(HIDE_WIDGET_KEY, next ? '1' : '0');
  };

  const changeOpacity = (v: number) => {
    const next = clampOpacity(v);
    setOpacity(next);
    localStorage.setItem(OPACITY_KEY, String(next));
  };

  const onHide = () => {
    setHideMenuOpen(false);
    if (hideHidesWidget) void window.electronAPI?.overlay.hide();
    else setCollapsed((v) => !v);
  };

  const submitForcedAnswer = useCallback((source: ForceHotkeySource = 'button') => {
    const event = { source, at: Date.now() } satisfies ForceHotkeyEvent;
    if (!acceptForceHotkey(lastForceHotkeyRef.current, event)) return;
    lastForceHotkeyRef.current = event;

    forceScreenFallbackOwnerRef.current = 0;
    screenAssistGenerationRef.current += 1;
    cancelRef.current?.();
    cancelRef.current = null;
    manualBusyRef.current = false;
    setNotice('');
    const status = input.trim() ? forceAnswer(input) : forceAnswer();
    if (input.trim()) setInput('');
    if (status === 'started' || status === 'finalizing') return;
    void runScreenAssist('', smart ? 'deep' : 'general');
  }, [forceAnswer, input, runScreenAssist, smart]);

  // ---------- Горячие клавиши ----------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      // Перемещение окна: Ctrl+стрелки (как «Move Cluely»).
      if (mod && !e.shiftKey && e.key.startsWith('Arrow')) {
        const step = 40;
        const delta: Record<string, [number, number]> = {
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
        };
        const d = delta[e.key];
        if (d && window.electronAPI?.overlay.move) {
          e.preventDefault();
          void window.electronAPI.overlay.move(d[0], d[1]);
          return;
        }
      }
      // Размер панели: Ctrl+= (больше) / Ctrl+- (меньше).
      if (mod && !e.shiftKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        void window.electronAPI?.overlay.resize?.(80, 60);
        return;
      }
      if (mod && !e.shiftKey && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        void window.electronAPI?.overlay.resize?.(-80, -60);
        return;
      }
      // Прокрутка ответа: Ctrl+Shift+↑/↓.
      if (mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const body = answerBodyRef.current;
        if (body) {
          e.preventDefault();
          body.scrollBy({ top: e.key === 'ArrowDown' ? 140 : -140, behavior: 'smooth' });
          return;
        }
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        if (e.repeat) return;
        submitForcedAnswer('renderer');
        return;
      }
      if (mod && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        closeExchange();
        setInput('');
        return;
      }
      if (mod && e.shiftKey && e.key === '\\') {
        e.preventDefault();
        stopSession();
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        setShowTranscript((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (menuOpen) setMenuOpen(false);
        else if (hideMenuOpen) setHideMenuOpen(false);
        else if (recap) closeRecap();
        else if (exchange) closeExchange();
        else void window.electronAPI?.overlay.hide();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, hideMenuOpen, exchange, recap, submitForcedAnswer, closeExchange, stopSession]);

  useEffect(
    () => window.electronAPI?.overlay.onForceAnswer?.(() => submitForcedAnswer('global')),
    [submitForcedAnswer],
  );

  // Клик мимо меню — закрыть.
  useEffect(() => {
    if (!menuOpen && !hideMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuOpen && menuRef.current && !menuRef.current.contains(target)) setMenuOpen(false);
      if (hideMenuOpen && hideMenuRef.current && !hideMenuRef.current.contains(target))
        setHideMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen, hideMenuOpen]);

  const positionMainMenu = useCallback(() => {
    if (!menuButtonRef.current || !menuPanelRef.current) return;
    setMenuPosition(
      clampFloatingPanel(
        menuButtonRef.current.getBoundingClientRect(),
        menuPanelRef.current.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        'top',
      ),
    );
  }, []);

  useLayoutEffect(() => {
    if (menuOpen) positionMainMenu();
  }, [menuOpen, modesOpen, positionMainMenu]);

  useEffect(() => {
    if (!menuOpen) return;
    window.addEventListener('resize', positionMainMenu);
    return () => window.removeEventListener('resize', positionMainMenu);
  }, [menuOpen, positionMainMenu]);

  const KEYBINDS: Array<{ labelKey: I18nKey; keys: string; d: string }> = [
    { labelKey: 'overlay.kb.toggle', keys: 'Ctrl+Shift+H', d: 'M2 4h20v13H2z|M8 20h8' },
    { labelKey: 'overlay.kb.ask', keys: 'Ctrl+↵', d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
    { labelKey: 'overlay.kb.clear', keys: 'Ctrl+R', d: 'M3 6h18|M8 6V4h8v2|M6 6l1 14h10l1-14' },
    { labelKey: 'overlay.kb.stop', keys: 'Ctrl+Shift+\\', d: 'M6 6h12v12H6z' },
    { labelKey: 'overlay.kb.move', keys: 'Ctrl+↑↓←→', d: 'M5 9 2 12l3 3|M9 5l3-3 3 3|M15 19l-3 3-3-3|M19 9l3 3-3 3|M2 12h20|M12 2v20' },
    { labelKey: 'overlay.kb.scroll', keys: 'Ctrl+Shift+↑↓', d: 'M8 7l4-4 4 4|M8 17l4 4 4-4' },
    { labelKey: 'overlay.kb.resize', keys: 'Ctrl +/−', d: 'M15 3h6v6|M9 21H3v-6|M21 3l-7 7|M3 21l7-7' },
    { labelKey: 'overlay.kb.transcript', keys: 'Ctrl+/', d: 'M4 6h16|M4 12h16|M4 18h10' },
  ];

  return (
    <div
      ref={rootRef}
      className={`ovl-root ${stealth ? 'ovl-root--stealth' : ''}`}
      style={{ opacity: opacity / 100 }}
    >
      {/* ---------- Пилл ---------- */}
      <div className="ovl-pill" data-overlay-hit="true">
        <button
          type="button"
          className="ovl-logo tip"
          data-tip={stealth ? t('overlay.pill.openStealth') : t('overlay.pill.open')}
          aria-label={t('overlay.pill.open')}
          onClick={() => void window.electronAPI?.overlay.openApp?.()}
        >
          {stealth ? (
            <Icon
              d="M3 3l18 18|M10.6 5.1A9 9 0 0 1 21 12c-.5 1-1.2 2-2 2.9M6.6 6.6A9 9 0 0 0 3 12c1.7 3.3 5 5 9 5 1 0 2-.1 2.9-.4"
              size={15}
            />
          ) : (
            <span className="text-[11px] font-black tracking-tight">SC</span>
          )}
        </button>

        {/* «Скрыть» с дропдауном (как ⌄ Hide в референсе). */}
        <div className="ovl-hide-group" ref={hideMenuRef}>
          <button
            type="button"
            className="ovl-hide-caret overlay-no-drag tip"
            data-tip={t('overlay.pill.hideMenuTip')}
            aria-label={t('overlay.pill.hideMenuAria')}
            onClick={() => setHideMenuOpen((v) => !v)}
          >
            <Icon d="m6 9 6 6 6-6" size={12} />
          </button>
          <button
            type="button"
            className="ovl-pill-btn tip"
            data-tip={
              hideHidesWidget
                ? t('overlay.pill.hideTip')
                : collapsed
                  ? t('overlay.pill.expandTip')
                  : t('overlay.pill.collapseTip')
            }
            onClick={onHide}
          >
            <Icon d="M18 6 6 18|M6 6l12 12" size={12} />
            {collapsed ? t('overlay.pill.show') : t('overlay.pill.hide')}
          </button>

          {hideMenuOpen && (
            <div
              className="overlay-menu ovl-hide-menu left-0 top-full mt-1.5"
              data-overlay-hit="true"
            >
              <button
                type="button"
                className="ovl-menu-toggle"
                onClick={() => {
                  toggleHideHidesWidget();
                }}
              >
                <Icon d="M2 4h20v13H2z|M8 20h8" />
                <span className="flex-1 text-left">{t('overlay.hideHidesWidget')}</span>
                <Switch on={hideHidesWidget} label={t('overlay.hideHidesWidget')} />
              </button>
              <div className="ovl-menu-sep" />
              <button
                type="button"
                className="btn-ghost w-full justify-start rounded-lg px-2 py-2 text-xs"
                onClick={() => {
                  setHideMenuOpen(false);
                  void window.electronAPI?.overlay.hide();
                }}
              >
                {t('overlay.hideOverlay')}
                <span className="ovl-kbd ml-auto">Ctrl+Shift+H</span>
              </button>
              {active && (
                <button
                  type="button"
                  className="btn-ghost w-full justify-start rounded-lg px-2 py-2 text-xs"
                  onClick={() => {
                    setHideMenuOpen(false);
                    stopSession();
                  }}
                >
                  {t('overlay.stopSession')}
                  <span className="ovl-kbd ml-auto">Ctrl+Shift+\</span>
                </button>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`ovl-rec tip ${active ? 'ovl-rec--live' : ''}`}
          data-tip={
            !hasStt && !active
              ? t('overlay.rec.needStt')
              : active
                ? t('overlay.rec.stopTip')
                : t('overlay.rec.startTip')
          }
          aria-label={active ? t('overlay.rec.stopAria') : t('overlay.rec.startAria')}
          disabled={!hasStt && !active}
          onClick={toggleSession}
        >
          {active ? (
            <span className="h-3 w-3 rounded-[3px] bg-red-400" />
          ) : (
            <span className="h-3 w-3 rounded-full bg-red-400" />
          )}
        </button>
      </div>

      {/* ---------- Экран итогов сессии ---------- */}
      <div className="ovl-stack">
      {recap ? (
        <div className="ovl-card ovl-recap animate-scale-in" data-overlay-hit="true">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-[15px] font-semibold text-ink">{t('overlay.recap.title')}</p>
              <p className="text-[11px] text-ink-faint">
                {new Date(recap.at).toLocaleString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  day: '2-digit',
                  month: 'short',
                })}
                {' · '}
                {recap.lines.filter((l) => l.isFinal).length} {t('overlay.linesWord')} ·{' '}
                {usageLog.length} {t('overlay.requestsWord')}
              </p>
            </div>
            <button
              type="button"
              className="overlay-icon-btn tip"
              data-tip={t('overlay.recap.closeTip')}
              aria-label={t('overlay.recap.close')}
              onClick={closeRecap}
            >
              <Icon d="M18 6 6 18|M6 6l12 12" />
            </button>
          </div>

          <div className="ovl-tabs">
            {(
              [
                ['summary', t('overlay.recap.tab.summary')],
                ['analysis', t('overlay.recap.tab.analysis')],
                ['transcript', t('overlay.recap.tab.transcript')],
                ['usage', t('overlay.recap.tab.usage')],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`ovl-tab ${recapTab === id ? 'ovl-tab--on' : ''}`}
                onClick={() => setRecapTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div ref={answerBodyRef} className="ovl-recap-body">
            {recapTab === 'summary' && (
              <div className="text-[14px] leading-relaxed text-ink">
                {recapSummary ? (
                  <MarkdownText text={recapSummary} />
                ) : (
                  <span className="ovl-think-dot" aria-label={t('overlay.recap.preparing')} />
                )}
                {recapSummaryStreaming && recapSummary && <span className="sc-caret" />}
              </div>
            )}

            {recapTab === 'analysis' && (
              <div className="ovl-analysis">
                {analysisLoading ? (
                  <div className="ovl-analysis-loading" role="status">
                    <span className="ovl-analysis-spinner" aria-hidden="true" />
                    <div>
                      <p className="ovl-analysis-loading-title">
                        {t('overlay.recap.analysisLoading')}
                      </p>
                      <div className="ovl-analysis-steps">
                        <span>{t('overlay.recap.analysisLoadingEvidence')}</span>
                        <span>{t('overlay.recap.analysisLoadingTopics')}</span>
                        <span>{t('overlay.recap.analysisLoadingSave')}</span>
                      </div>
                    </div>
                  </div>
                ) : analysis ? (
                  <div className="ovl-analysis-result">
                    <section className="ovl-analysis-conclusion">
                      <span className="ovl-analysis-eyebrow">
                        {t('overlay.recap.overallLevel')}
                      </span>
                      <strong>{analysis.overallLevel}</strong>
                      <p>{analysis.conclusion}</p>
                    </section>

                    <div className="ovl-analysis-columns">
                      <section className="ovl-analysis-section ovl-analysis-section--strong">
                        <h3>{t('overlay.recap.strengths')}</h3>
                        {analysis.strengths.map((item, index) => (
                          <article key={`${item.topic}-${index}`} className="ovl-analysis-evidence">
                            <strong>{item.topic}</strong>
                            <p>{item.evidence}</p>
                          </article>
                        ))}
                      </section>

                      <section className="ovl-analysis-section ovl-analysis-section--weak">
                        <h3>{t('overlay.recap.weaknesses')}</h3>
                        {analysis.weaknesses.map((item, index) => (
                          <article key={`${item.topic}-${index}`} className="ovl-analysis-evidence">
                            <strong>{item.topic}</strong>
                            <p>{item.evidence}</p>
                            <div className="ovl-analysis-action-note">
                              <span>{t('overlay.recap.learningAction')}</span>
                              {item.learningAction}
                            </div>
                          </article>
                        ))}
                      </section>
                    </div>

                    <section className="ovl-analysis-topics">
                      <h3>{t('overlay.recap.topicScores')}</h3>
                      {analysis.topicAssessments.map((item) => (
                        <div key={item.topic} className="ovl-analysis-score">
                          <div className="ovl-analysis-score-head">
                            <span>{item.topic}</span>
                            <strong>{item.score}/100</strong>
                          </div>
                          <div className="ovl-analysis-score-track" aria-hidden="true">
                            <span
                              className="ovl-analysis-score-fill"
                              style={{ width: `${Math.max(0, Math.min(100, item.score))}%` }}
                            />
                          </div>
                          <span className="ovl-analysis-confidence">
                            {t('overlay.recap.confidence')} {Math.round(item.confidence * 100)}%
                          </span>
                        </div>
                      ))}
                    </section>
                  </div>
                ) : analysisError ? (
                  <div className="ovl-analysis-error" role="alert">
                    <Icon d="M12 9v4|M12 17h.01|M10.3 3.7 2.5 17.2A2 2 0 0 0 4.2 20h15.6a2 2 0 0 0 1.7-2.8L13.7 3.7a2 2 0 0 0-3.4 0z" size={18} />
                    <div>
                      <strong>{t('overlay.recap.analysisFailed')}</strong>
                      <p>{analysisError}</p>
                      {recap.sessionId && (
                        <button type="button" className="ovl-analysis-retry" onClick={analyzeRecap}>
                          {t('overlay.recap.retryAnalysis')}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="ovl-analysis-empty">
                    <div className="ovl-analysis-empty-icon" aria-hidden="true">
                      <Icon d="M12 3v18|M3 12h18" size={18} />
                    </div>
                    <div>
                      <h3>{t('overlay.recap.analysisTitle')}</h3>
                      <p>
                        {recap.sessionId
                          ? t('overlay.recap.analysisIntro')
                          : t('overlay.recap.analysisUnavailable')}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ovl-analysis-action"
                      onClick={analyzeRecap}
                      disabled={!recap.sessionId}
                    >
                      <Icon d="M12 3v18|M3 12h18" size={14} />
                      {t('overlay.recap.analyze')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {recapTab === 'transcript' &&
              (recap.lines.filter((l) => l.isFinal).length === 0 ? (
                <p className="text-xs text-ink-faint">{t('overlay.recap.noLines')}</p>
              ) : (
                <div className="space-y-2 text-[13px]">
                  {recap.lines
                    .filter((l) => l.isFinal)
                    .map((line, i) => (
                      <div key={i}>
                        <span
                          className={
                            line.speaker === 'me'
                              ? 'text-[11px] font-semibold text-violet-300'
                              : 'text-[11px] font-semibold text-emerald-400'
                          }
                        >
                          {line.speaker === 'me' ? t('overlay.me') : t('overlay.interviewer')}
                        </span>
                        <p className="text-ink">{line.text}</p>
                      </div>
                    ))}
                </div>
              ))}

            {recapTab === 'usage' &&
              (usageLog.length === 0 ? (
                <p className="text-xs text-ink-faint">{t('overlay.recap.noUsage')}</p>
              ) : (
                <div className="space-y-4">
                  {usageLog.map((u, i) => (
                    <div key={i}>
                      <div className="mb-1.5 flex justify-end">
                        <span className="ovl-bubble">{u.request}</span>
                      </div>
                      <p className="ovl-answer-label">
                        {u.image ? t('overlay.viewedScreen') : u.label}
                      </p>
                      <div className="text-[13.5px] leading-relaxed text-ink">
                        <MarkdownText text={u.text} />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-3">
            <button type="button" className="ovl-resume" onClick={resumeFromRecap}>
              <Icon d="m8 5 12 7-12 7z" size={13} />
              {t('overlay.resume')}
            </button>
            {recapTab === 'summary' && (
              <button
                type="button"
                className="overlay-icon-btn tip"
                data-tip={t('overlay.regenSummary')}
                aria-label={t('overlay.regenSummary')}
                disabled={recapSummaryStreaming}
                onClick={() => generateSummary(recap.lines)}
              >
                <Icon d="M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5" />
              </button>
            )}
            <div className="flex-1" />
            <CopyButton
              label={t('overlay.copy')}
              text={
                recapTab === 'transcript'
                  ? buildTranscript(recap.lines, t('overlay.me'), t('overlay.interviewer'))
                  : recapTab === 'usage'
                    ? usageLog.map((u) => `▸ ${u.request}\n${u.text}`).join('\n\n')
                    : recapTab === 'analysis'
                      ? analysis?.markdown ?? ''
                      : recapSummary
              }
            />
          </div>
        </div>
      ) : (
        !collapsed && (
          <>
            {/* ---------- Панель ответа ---------- */}
            {exchange && (
              <div
                className="ovl-card ovl-response animate-scale-in"
                data-overlay-hit="true"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <button
                    type="button"
                    className="overlay-icon-btn ovl-close tip"
                    data-tip={t('overlay.clearTip')}
                    aria-label={t('overlay.clearAria')}
                    onClick={closeExchange}
                  >
                    <Icon d="M18 6 6 18|M6 6l12 12" />
                  </button>
                  <span className="ovl-bubble">{exchange.request}</span>
                </div>

                {exchange.image ? (
                  <span className="ovl-viewed ovl-answer-label">
                    {t('overlay.viewedScreen')}
                    <span className="ovl-shot-pop">
                      <img src={exchange.image} alt={t('overlay.screenshotAlt')} />
                    </span>
                  </span>
                ) : (
                  <p className="ovl-answer-label">
                    {exchange.label === 'Live' ? t('overlay.liveAnswer') : exchange.label}
                  </p>
                )}
                <div ref={answerBodyRef} className="ovl-answer-body">
                  {exchange.text ? (
                    <MarkdownText text={exchange.text} />
                  ) : (
                    <span className="ovl-think-dot" aria-label={t('overlay.thinking')} />
                  )}
                  {exchange.streaming && exchange.text && <span className="sc-caret" />}
                </div>

                {!exchange.streaming && exchange.text && (
                  <div className="mt-2 flex justify-start">
                    <CopyButton text={exchange.text} label={t('overlay.copy')} />
                  </div>
                )}
              </div>
            )}

            {/* ---------- Командная панель ---------- */}
            <div className="ovl-bar ovl-card" data-overlay-hit="true">
              <div className="ovl-actions">
                {(Object.keys(ACTIONS) as ActionId[]).map((id, i) => (
                  <span key={id} className="flex items-center gap-0.5">
                    {i > 0 && <span className="ovl-dot-sep">·</span>}
                    <button
                      type="button"
                      className="ovl-action tip"
                      data-tip={t(ACTIONS[id].tipKey)}
                      onClick={() => runAction(id)}
                    >
                      <Icon
                        d={
                          id === 'assist'
                            ? 'm12 3-1.9 5.8L4 11l6.1 2.2L12 19l1.9-5.8L20 11l-6.1-2.2z'
                            : id === 'say'
                              ? 'M13 2 3 14h7l-1 8 10-12h-7z'
                              : id === 'followup'
                                ? 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'
                                : id === 'recap'
                                  ? 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5'
                                  : 'M2 4h20v12H2z|M8 20h8|M12 16v4'
                        }
                      />
                      {t(ACTIONS[id].labelKey)}
                    </button>
                  </span>
                ))}
              </div>

              <div className="ovl-input-wrap">
                <textarea
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      runAction('assist', input);
                    }
                  }}
                  placeholder={t('overlay.inputPlaceholder')}
                  className="ovl-input"
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    className={`ovl-smart tip ${smart ? 'ovl-smart--on' : ''}`}
                    data-tip={t('overlay.smartTip')}
                    onClick={toggleSmart}
                  >
                    Smart
                  </button>

                  <div className="relative" ref={menuRef}>
                    <button
                      ref={menuButtonRef}
                      type="button"
                      className="overlay-icon-btn tip"
                      data-tip={t('overlay.menuTip')}
                      aria-label={t('overlay.menuAria')}
                      onClick={() => setMenuOpen((v) => !v)}
                    >
                      <Icon d="M5 12h.01M12 12h.01M19 12h.01" />
                    </button>
                    {menuOpen && (
                      <div
                        ref={menuPanelRef}
                        className="overlay-menu ovl-main-menu"
                        data-overlay-hit="true"
                        style={{
                          position: 'fixed',
                          left: menuPosition.left,
                          top: menuPosition.top,
                          maxHeight: 'calc(100vh - 16px)',
                          margin: 0,
                        }}
                      >
                        <p className="ovl-menu-head">{t('overlay.shortcutsHead')}</p>
                        {KEYBINDS.map((k) => (
                          <div key={k.labelKey} className="ovl-menu-row">
                            <Icon d={k.d} />
                            <span className="flex-1">{t(k.labelKey)}</span>
                            <span className="ovl-kbd">{k.keys}</span>
                          </div>
                        ))}

                        <div className="ovl-menu-sep" />

                        <button
                          type="button"
                          className="ovl-menu-toggle tip"
                          data-tip={t('overlay.stealthTip')}
                          onClick={toggleStealth}
                        >
                          <Icon d="M3 3l18 18|M10.6 5.1A9 9 0 0 1 21 12c-.5 1-1.2 2-2 2.9M6.6 6.6A9 9 0 0 0 3 12c1.7 3.3 5 5 9 5 1 0 2-.1 2.9-.4" />
                          <span className="flex-1 text-left">{t('overlay.stealth')}</span>
                          <Switch on={stealth} label={t('overlay.stealthAria')} />
                        </button>
                        <button
                          type="button"
                          className="ovl-menu-toggle tip"
                          data-tip={t('overlay.avoidFocusTip')}
                          onClick={toggleAvoidFocus}
                        >
                          <Icon d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0|M12 2v3|M12 19v3|M2 12h3|M19 12h3" />
                          <span className="flex-1 text-left">{t('overlay.avoidFocus')}</span>
                          <Switch on={avoidFocus} label={t('overlay.avoidFocus')} />
                        </button>

                        {/* Прозрачность панели — чтобы видеть, что под ней. */}
                        <div className="ovl-menu-toggle" style={{ cursor: 'default' }}>
                          <Icon d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6" />
                          <span className="flex-1 text-left">{t('overlay.opacity')}</span>
                          <span className="mr-1 text-[11px] tabular-nums text-ink-faint">{opacity}%</span>
                          <input
                            type="range"
                            min={40}
                            max={100}
                            step={5}
                            value={opacity}
                            onChange={(e) => changeOpacity(Number(e.target.value))}
                            className="w-20 accent-emerald-400"
                            aria-label={t('overlay.opacity')}
                          />
                        </div>

                        <div className="ovl-menu-sep" />

                        {/* Режимы ответа (как Modes у Cluely): ✓ на активном. */}
                        <button
                          type="button"
                          className="ovl-menu-toggle"
                          onClick={() => setModesOpen((v) => !v)}
                        >
                          <Icon d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <span className="flex-1 text-left">{t('overlay.modes')}</span>
                          <span className="text-[11px] text-ink-faint">
                            {activeMode.id === 'general' ? t('modes.general') : activeMode.name}
                          </span>
                          <Icon d={modesOpen ? 'm6 15 6-6 6 6' : 'm9 6 6 6-6 6'} size={12} />
                        </button>
                        {modesOpen && (
                          <div className="ovl-modes-list">
                            {modes.map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                className="btn-ghost w-full justify-start rounded-lg px-2 py-2 text-xs"
                                onClick={() => {
                                  setActiveMode(m.id);
                                  setModesOpen(false);
                                }}
                              >
                                <span
                                  className={
                                    m.id === activeMode.id ? 'text-accent' : 'text-transparent'
                                  }
                                >
                                  ✓{' '}
                                </span>
                                {m.id === 'general' ? t('modes.general') : m.name}
                              </button>
                            ))}
                            <button
                              type="button"
                              className="btn-ghost w-full justify-start rounded-lg px-2 py-2 text-xs text-ink-faint"
                              onClick={() => {
                                setMenuOpen(false);
                                void window.electronAPI?.overlay.openSettings?.('modes');
                              }}
                            >
                              {t('overlay.manageModes')}
                            </button>
                          </div>
                        )}

                        <button
                          type="button"
                          className="ovl-menu-toggle"
                          onClick={() => {
                            setShowTranscript((v) => !v);
                          }}
                        >
                          <Icon d="M4 6h16|M4 12h16|M4 18h10" />
                          <span className="flex-1 text-left">{t('overlay.liveTranscript')}</span>
                          <Switch on={showTranscript} label={t('overlay.liveTranscript')} />
                        </button>

                        <p className="ovl-menu-head mt-1">{t('overlay.audioSourceHead')}</p>
                        {(
                          [
                            [t('overlay.src.both'), { mic: true, system: true }],
                            [t('overlay.src.micOnly'), { mic: true, system: false }],
                            [t('overlay.src.sysOnly'), { mic: false, system: true }],
                          ] as const
                        ).map(([label, src]) => (
                          <button
                            key={label}
                            type="button"
                            className="btn-ghost w-full justify-start rounded-lg px-2 py-2 text-xs"
                            onClick={() => {
                              setSources(src);
                              setMenuOpen(false);
                              if (active) {
                                void stop().then(() => void start(src, sttOptions));
                              }
                            }}
                          >
                            {sources.mic === src.mic && sources.system === src.system ? '✓ ' : ''}
                            {label}
                          </button>
                        ))}

                        <div className="ovl-menu-sep" />
                        <button
                          type="button"
                          className="btn-ghost w-full justify-start rounded-lg px-2 py-2 text-xs"
                          onClick={() => void window.electronAPI?.overlay.openSettings?.()}
                        >
                          {t('overlay.settings')}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex-1" />
                  <button
                    type="button"
                    className="ovl-send tip"
                    data-tip={t('overlay.sendTip')}
                    aria-label={t('overlay.sendAria')}
                    disabled={
                      exchange?.streaming ||
                      (!input.trim() &&
                        lines.length === 0 &&
                        !window.electronAPI?.overlay.captureScreen)
                    }
                    onClick={() => runAction('assist', input)}
                  >
                    {exchange?.streaming && manualBusyRef.current ? (
                      <span className="ovl-send-spinner" />
                    ) : (
                      <Icon d="m5 12 14 0|m13 6 6 6-6 6" size={13} />
                    )}
                  </button>
                </div>
              </div>

              {notice && <p className="px-1.5 pt-1.5 text-[11.5px] text-amber-300">{notice}</p>}
            </div>

            {/* ---------- Транскрипт (по запросу) ---------- */}
            {showTranscript && (
              <div
                className="ovl-card mt-2 max-h-[30vh] overflow-y-auto p-3"
                data-overlay-hit="true"
              >
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  {t('overlay.kb.transcript')}
                </p>
                {lines.length === 0 ? (
                  <p className="text-xs text-ink-faint">{t('overlay.transcriptEmpty')}</p>
                ) : (
                  <div className="space-y-1 text-[12.5px]">
                    {lines.map((line, i) => (
                      <p key={i}>
                        <span
                          className={
                            line.speaker === 'me' ? 'text-violet-300' : 'text-emerald-400'
                          }
                        >
                          {line.speaker === 'me' ? t('overlay.meColon') : t('overlay.interviewerColon')}
                        </span>
                        <span className={line.isFinal ? 'text-ink' : 'italic text-ink-muted'}>
                          {line.text}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )
      )}
      </div>
      <OverlayTooltipLayer rootRef={rootRef} />
    </div>
  );
}
