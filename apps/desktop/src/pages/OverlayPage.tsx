import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useLiveCopilot } from '../hooks/useLiveCopilot';
import { useLiveCopilotPrefs } from '../hooks/useLiveCopilotPrefs';
import { useApp } from '../context/AppContext';
import type { TranscriptLine } from '../hooks/useLiveCopilot';
import MarkdownText from '../components/MarkdownText';
import { forceDarkTheme } from '../lib/theme';
import { modeInstructionPrefix, useAnswerModes } from '../lib/answerModes';
import { deriveLiveExchange } from '../lib/liveOverlaySync';

/**
 * Плавающий оверлей SkillCue (вдохновлён Cluely, но в навы+зелёном стиле):
 * — пилл сверху: логотип (открывает приложение), «Скрыть» с дропдауном, запись;
 * — командная панель: Подсказка · Что сказать? · Доп. вопросы · Резюме · Экран,
 *   поле ввода (Ctrl+Enter = Подсказка), Smart, меню «…» с keybinds/тумблерами;
 * — панель ответа: синий пузырь запроса + стримящийся ответ + копирование;
 * — экран итогов сессии (Summary / Transcript / Usage) при остановке записи.
 * Undetectability прячет оверлей от скринов/записи и рисует пунктирную обводку.
 */

type ActionId = 'assist' | 'say' | 'followup' | 'recap' | 'screen';

const ACTIONS: Record<
  ActionId,
  { label: string; tip: string; needsContext: boolean; prompt: string }
> = {
  assist: {
    label: 'Подсказка',
    tip: 'Готовый ответ на последний вопрос интервьюера (Ctrl+Enter)',
    needsContext: false,
    prompt:
      'Помоги ответить на последний вопрос интервьюера из разговора. Дай готовый ответ от первого лица, чтобы произнести вслух: 40–80 слов, по делу, без вступлений.',
  },
  say: {
    label: 'Что сказать?',
    tip: 'Подсказка, что сказать прямо сейчас по ходу разговора',
    needsContext: true,
    prompt:
      'Подскажи, что мне сказать прямо сейчас, учитывая ход разговора. Готовая фраза/мини-ответ от первого лица, максимум 60 слов.',
  },
  followup: {
    label: 'Доп. вопросы',
    tip: 'Какие уточняющие вопросы, скорее всего, зададут дальше',
    needsContext: true,
    prompt:
      'Какие уточняющие вопросы, скорее всего, задаст интервьюер после моего последнего ответа? Дай 3–5 вопросов и к каждому — краткую подсказку, как отвечать.',
  },
  recap: {
    label: 'Резюме',
    tip: 'Краткое резюме разговора: темы, мои ответы, открытые вопросы',
    needsContext: true,
    prompt:
      'Сделай краткое резюме разговора: какие темы подняли, что я ответил, какие вопросы остались открытыми. 3–6 пунктов.',
  },
  screen: {
    label: 'Экран',
    tip: 'Скриншот экрана → разбор задачи/кода/вопроса и готовая подсказка',
    needsContext: false,
    prompt: '', // vision-путь: скриншот + вопрос, см. runAction
  },
};

const SMART_KEY = 'skillcue.overlaySmart';
const STEALTH_KEY = 'skillcue.overlayStealth';
const AVOID_FOCUS_KEY = 'skillcue.overlayAvoidFocus';
const HIDE_WIDGET_KEY = 'skillcue.overlayHideWidget';
const USE_SCREEN_KEY = 'skillcue.overlayUseScreen';

type RecapTab = 'summary' | 'transcript' | 'usage';

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
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="overlay-icon-btn tip flex items-center gap-1.5 text-[12px]"
      data-tip={copied ? 'Скопировано ✓' : 'Скопировать'}
      aria-label="Скопировать"
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
      {label && <span>{copied ? 'Скопировано' : label}</span>}
    </button>
  );
}

function buildTranscript(ls: TranscriptLine[]): string {
  return ls
    .filter((l) => l.isFinal)
    .map((l) => `${l.speaker === 'me' ? 'Я' : 'Интервьюер'}: ${l.text}`)
    .join('\n');
}

export default function OverlayPage() {
  const { hasStt } = useApp();
  const { active, lines, answerHistory, currentQuestion, streamText, streaming, start, stop } =
    useLiveCopilot();
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
  const [collapsed, setCollapsed] = useState(false);

  // Итоги сессии.
  const [usageLog, setUsageLog] = useState<UsageEntry[]>([]);
  const [recap, setRecap] = useState<{ lines: TranscriptLine[]; at: number } | null>(null);
  const [recapTab, setRecapTab] = useState<RecapTab>('summary');
  const [recapSummary, setRecapSummary] = useState('');
  const [recapSummaryStreaming, setRecapSummaryStreaming] = useState(false);

  const cancelRef = useRef<(() => void) | null>(null);
  const summaryCancelRef = useRef<(() => void) | null>(null);
  const manualBusyRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hideMenuRef = useRef<HTMLDivElement>(null);
  const answerBodyRef = useRef<HTMLDivElement>(null);

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

  useEffect(
    () => () => {
      cancelRef.current?.();
      summaryCancelRef.current?.();
    },
    [],
  );

  const transcriptContext = useCallback((): string => {
    const recent = lines.slice(-30).filter((l) => l.isFinal);
    return recent
      .map((l) => `${l.speaker === 'me' ? 'Я' : 'Интервьюер'}: ${l.text}`)
      .join('\n');
  }, [lines]);

  const runScreenAssist = useCallback(
    async (customText: string) => {
      const capture = window.electronAPI?.overlay.captureScreen;
      if (!capture) {
        setNotice('Анализ экрана доступен только в десктоп-приложении.');
        return;
      }
      setNotice('');
      cancelRef.current?.();
      manualBusyRef.current = true;
      const request = customText || 'Что на экране?';
      setExchange({ label: 'Экран', request, text: '', streaming: true });
      setInput('');

      const image = await capture().catch(() => '');
      if (!image) {
        manualBusyRef.current = false;
        setExchange(null);
        setNotice('Не удалось сделать скриншот экрана.');
        return;
      }
      setExchange((prev) => (prev ? { ...prev, image } : prev));

      let acc = '';
      cancelRef.current = api.streamScreenAssist(
        image,
        `${modeInstructionPrefix()}${customText}`.trim(),
        {
          onChunk: (t) => {
            acc += t;
            setExchange((prev) => (prev ? { ...prev, text: prev.text + t } : prev));
          },
          onDone: () => {
            manualBusyRef.current = false;
            setExchange((prev) => (prev ? { ...prev, streaming: false } : prev));
            setUsageLog((log) => [...log, { label: 'Экран', request, text: acc, image }]);
          },
          onError: (msg) => {
            manualBusyRef.current = false;
            setExchange((prev) =>
              prev ? { ...prev, streaming: false, text: prev.text || `⚠ ${msg}` } : prev,
            );
          },
        },
        {
          context: transcriptContext() || undefined,
          mode: smart ? 'deep' : 'general',
        },
      );
    },
    [smart, transcriptContext],
  );

  const runAction = useCallback(
    (id: ActionId, customText?: string) => {
      const action = ACTIONS[id];
      const context = transcriptContext();
      const custom = (customText ?? '').trim();

      if (id === 'screen') {
        void runScreenAssist(custom);
        return;
      }

      // Как в референсе: если текстового контекста не хватает, Подсказка сама
      // «смотрит» на экран (скриншот) вместо отказа. Отключается в настройках.
      if (
        id === 'assist' &&
        !context &&
        window.electronAPI?.overlay.captureScreen &&
        localStorage.getItem(USE_SCREEN_KEY) !== '0'
      ) {
        void runScreenAssist(custom);
        return;
      }

      if (!custom && !context) {
        setNotice(
          action.needsContext
            ? 'Нет разговора: запустите запись (кнопка ● в пилле) — и действие заработает.'
            : 'Введите вопрос или запустите запись — тогда я отвечу по разговору.',
        );
        return;
      }
      setNotice('');
      cancelRef.current?.();
      manualBusyRef.current = true;

      // Инструкция активного режима (см. Настройки → Режимы ответа).
      const message =
        modeInstructionPrefix() +
        (custom
          ? `${custom}${context ? '\n\n(Отвечай с учётом текущего разговора.)' : ''}`
          : action.prompt);
      const request = custom || action.label;

      setExchange({ label: action.label, request, text: '', streaming: true });
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
            setUsageLog((log) => [...log, { label: action.label, request, text: acc }]);
          },
          onError: (msg) => {
            manualBusyRef.current = false;
            setExchange((prev) =>
              prev ? { ...prev, streaming: false, text: prev.text || `⚠ ${msg}` } : prev,
            );
          },
        },
        {
          mode: smart ? 'deep' : 'general',
          context: context || undefined,
        },
      );
    },
    [runScreenAssist, smart, transcriptContext],
  );

  // Live-ответы (авто) — в ту же панель, пока нет ручного запроса.
  const lastEntry = answerHistory[answerHistory.length - 1];
  useEffect(() => {
    if (manualBusyRef.current) return;
    const view = deriveLiveExchange(streamText, streaming, lastEntry?.spoken);
    if (!view.show) return;
    const question = currentQuestion || lastEntry?.question || 'Вопрос интервьюера';
    setExchange({ label: 'Live', request: question, text: view.text, streaming });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamText, streaming, lastEntry?.id, lastEntry?.spoken, currentQuestion]);

  const toggleSmart = () => {
    const next = !smart;
    setSmart(next);
    localStorage.setItem(SMART_KEY, next ? '1' : '0');
  };

  const closeExchange = useCallback(() => {
    cancelRef.current?.();
    manualBusyRef.current = false;
    setExchange(null);
  }, []);

  // ---------- Итоги сессии ----------
  const generateSummary = useCallback((ls: TranscriptLine[]) => {
    const transcript = buildTranscript(ls);
    summaryCancelRef.current?.();
    if (!transcript) {
      setRecapSummary('Недостаточно реплик для резюме — запись была слишком короткой.');
      setRecapSummaryStreaming(false);
      return;
    }
    setRecapSummary('');
    setRecapSummaryStreaming(true);
    summaryCancelRef.current = api.streamMeetingSummary(transcript, {
      onChunk: (c) => setRecapSummary((s) => s + c),
      onDone: () => setRecapSummaryStreaming(false),
      onError: (m) => {
        setRecapSummaryStreaming(false);
        setRecapSummary((s) => s || `⚠ ${m}`);
      },
    });
  }, []);

  const openRecap = useCallback(
    (snapshot: TranscriptLine[]) => {
      setRecap({ lines: snapshot, at: Date.now() });
      setRecapTab('summary');
      generateSummary(snapshot);
    },
    [generateSummary],
  );

  const closeRecap = useCallback(() => {
    summaryCancelRef.current?.();
    setRecap(null);
    setRecapSummary('');
    setRecapSummaryStreaming(false);
  }, []);

  const stopSession = useCallback(() => {
    if (!active) return;
    const snapshot = lines.slice();
    void stop().then(() => {
      if (snapshot.some((l) => l.isFinal)) openRecap(snapshot);
    });
  }, [active, lines, stop, openRecap]);

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

  const onHide = () => {
    setHideMenuOpen(false);
    if (hideHidesWidget) void window.electronAPI?.overlay.hide();
    else setCollapsed((v) => !v);
  };

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
        runAction('assist', input);
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
  }, [input, menuOpen, hideMenuOpen, exchange, recap, runAction, closeExchange, stopSession]);

  // Клик мимо меню — закрыть.
  useEffect(() => {
    if (!menuOpen && !hideMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuOpen && menuRef.current && !menuRef.current.contains(t)) setMenuOpen(false);
      if (hideMenuOpen && hideMenuRef.current && !hideMenuRef.current.contains(t))
        setHideMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen, hideMenuOpen]);

  const KEYBINDS: Array<{ label: string; keys: string; d: string }> = [
    { label: 'Показать / скрыть', keys: 'Ctrl+Shift+H', d: 'M2 4h20v13H2z|M8 20h8' },
    { label: 'Спросить (Подсказка)', keys: 'Ctrl+↵', d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
    { label: 'Очистить чат', keys: 'Ctrl+R', d: 'M3 6h18|M8 6V4h8v2|M6 6l1 14h10l1-14' },
    { label: 'Остановить сессию', keys: 'Ctrl+Shift+\\', d: 'M6 6h12v12H6z' },
    { label: 'Переместить оверлей', keys: 'Ctrl+↑↓←→', d: 'M5 9 2 12l3 3|M9 5l3-3 3 3|M15 19l-3 3-3-3|M19 9l3 3-3 3|M2 12h20|M12 2v20' },
    { label: 'Прокрутка ответа', keys: 'Ctrl+Shift+↑↓', d: 'M8 7l4-4 4 4|M8 17l4 4 4-4' },
    { label: 'Транскрипт', keys: 'Ctrl+/', d: 'M4 6h16|M4 12h16|M4 18h10' },
  ];

  return (
    <div className={`ovl-root ${stealth ? 'ovl-root--stealth' : ''}`}>
      {/* ---------- Пилл ---------- */}
      <div className="ovl-pill">
        <button
          type="button"
          className="ovl-logo tip"
          data-tip={stealth ? 'Скрытый режим активен · Открыть SkillCue' : 'Открыть SkillCue'}
          aria-label="Открыть SkillCue"
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
            data-tip="Что делает «Скрыть»"
            aria-label="Меню скрытия"
            onClick={() => setHideMenuOpen((v) => !v)}
          >
            <Icon d="m6 9 6 6 6-6" size={12} />
          </button>
          <button
            type="button"
            className="ovl-pill-btn tip"
            data-tip={
              hideHidesWidget
                ? 'Скрыть оверлей (Ctrl+Shift+H вернёт)'
                : collapsed
                  ? 'Развернуть панели'
                  : 'Свернуть до пилла'
            }
            onClick={onHide}
          >
            <Icon d="M18 6 6 18|M6 6l12 12" size={12} />
            {collapsed ? 'Показать' : 'Скрыть'}
          </button>

          {hideMenuOpen && (
            <div className="overlay-menu ovl-hide-menu left-0 top-full mt-1.5">
              <button
                type="button"
                className="ovl-menu-toggle"
                onClick={() => {
                  toggleHideHidesWidget();
                }}
              >
                <Icon d="M2 4h20v13H2z|M8 20h8" />
                <span className="flex-1 text-left">«Скрыть» прячет весь виджет</span>
                <Switch on={hideHidesWidget} label="«Скрыть» прячет весь виджет" />
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
                Скрыть оверлей
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
                  Остановить сессию
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
              ? 'Скачайте речевую модель: Настройки → «Речь и звук»'
              : active
                ? 'Остановить запись → итоги сессии'
                : 'Начать запись разговора (live-подсказки)'
          }
          aria-label={active ? 'Остановить запись' : 'Начать запись'}
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
      {recap ? (
        <div className="ovl-card ovl-recap animate-scale-in">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-[15px] font-semibold text-ink">Итоги сессии</p>
              <p className="text-[11px] text-ink-faint">
                {new Date(recap.at).toLocaleString('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                  day: '2-digit',
                  month: 'short',
                })}
                {' · '}
                {recap.lines.filter((l) => l.isFinal).length} реплик · {usageLog.length} запросов
              </p>
            </div>
            <button
              type="button"
              className="overlay-icon-btn tip"
              data-tip="Закрыть итоги (Esc)"
              aria-label="Закрыть итоги"
              onClick={closeRecap}
            >
              <Icon d="M18 6 6 18|M6 6l12 12" />
            </button>
          </div>

          <div className="ovl-tabs">
            {(
              [
                ['summary', 'Резюме'],
                ['transcript', 'Транскрипт'],
                ['usage', 'Запросы'],
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
                  <span className="ovl-think-dot" aria-label="Готовлю резюме…" />
                )}
                {recapSummaryStreaming && recapSummary && <span className="sc-caret" />}
              </div>
            )}

            {recapTab === 'transcript' &&
              (recap.lines.filter((l) => l.isFinal).length === 0 ? (
                <p className="text-xs text-ink-faint">Реплик не было записано.</p>
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
                          {line.speaker === 'me' ? 'Я' : 'Интервьюер'}
                        </span>
                        <p className="text-ink">{line.text}</p>
                      </div>
                    ))}
                </div>
              ))}

            {recapTab === 'usage' &&
              (usageLog.length === 0 ? (
                <p className="text-xs text-ink-faint">
                  За сессию не было ручных запросов к ИИ. Нажимайте Подсказку/Экран во время
                  разговора — они появятся здесь.
                </p>
              ) : (
                <div className="space-y-4">
                  {usageLog.map((u, i) => (
                    <div key={i}>
                      <div className="mb-1.5 flex justify-end">
                        <span className="ovl-bubble">{u.request}</span>
                      </div>
                      <p className="ovl-answer-label">
                        {u.image ? 'Смотрел экран' : u.label}
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
              Продолжить сессию
            </button>
            {recapTab === 'summary' && (
              <button
                type="button"
                className="overlay-icon-btn tip"
                data-tip="Перегенерировать резюме"
                aria-label="Перегенерировать резюме"
                disabled={recapSummaryStreaming}
                onClick={() => generateSummary(recap.lines)}
              >
                <Icon d="M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5" />
              </button>
            )}
            <div className="flex-1" />
            <CopyButton
              label="Копировать"
              text={
                recapTab === 'transcript'
                  ? buildTranscript(recap.lines)
                  : recapTab === 'usage'
                    ? usageLog.map((u) => `▸ ${u.request}\n${u.text}`).join('\n\n')
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
              <div className="ovl-card ovl-response animate-scale-in">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <button
                    type="button"
                    className="overlay-icon-btn ovl-close tip"
                    data-tip="Очистить чат (Ctrl+R)"
                    aria-label="Очистить чат"
                    onClick={closeExchange}
                  >
                    <Icon d="M18 6 6 18|M6 6l12 12" />
                  </button>
                  <span className="ovl-bubble">{exchange.request}</span>
                </div>

                {exchange.image ? (
                  <span className="ovl-viewed ovl-answer-label">
                    Смотрел экран
                    <span className="ovl-shot-pop">
                      <img src={exchange.image} alt="Скриншот, отправленный модели" />
                    </span>
                  </span>
                ) : (
                  <p className="ovl-answer-label">
                    {exchange.label === 'Live' ? 'Live-ответ по разговору' : exchange.label}
                  </p>
                )}
                <div ref={answerBodyRef} className="ovl-answer-body">
                  {exchange.text ? (
                    <MarkdownText text={exchange.text} />
                  ) : (
                    <span className="ovl-think-dot" aria-label="Думаю…" />
                  )}
                  {exchange.streaming && exchange.text && <span className="sc-caret" />}
                </div>

                {!exchange.streaming && exchange.text && (
                  <div className="mt-2 flex justify-start">
                    <CopyButton text={exchange.text} label="Копировать" />
                  </div>
                )}
              </div>
            )}

            {/* ---------- Командная панель ---------- */}
            <div className="ovl-bar ovl-card">
              <div className="ovl-actions">
                {(Object.keys(ACTIONS) as ActionId[]).map((id, i) => (
                  <span key={id} className="flex items-center gap-0.5">
                    {i > 0 && <span className="ovl-dot-sep">·</span>}
                    <button
                      type="button"
                      className="ovl-action tip"
                      data-tip={ACTIONS[id].tip}
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
                      {ACTIONS[id].label}
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
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      runAction('assist', input);
                    }
                  }}
                  placeholder="Спросите о разговоре или экране — Ctrl+Enter для Подсказки"
                  className="ovl-input"
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    className={`ovl-smart tip ${smart ? 'ovl-smart--on' : ''}`}
                    data-tip="Smart: дольше думает перед ответом — глубже и точнее"
                    onClick={toggleSmart}
                  >
                    Smart
                  </button>

                  <div className="relative" ref={menuRef}>
                    <button
                      type="button"
                      className="overlay-icon-btn tip"
                      data-tip="Горячие клавиши, скрытность, источник звука, настройки"
                      aria-label="Меню"
                      onClick={() => setMenuOpen((v) => !v)}
                    >
                      <Icon d="M5 12h.01M12 12h.01M19 12h.01" />
                    </button>
                    {menuOpen && (
                      <div className="overlay-menu ovl-main-menu bottom-full left-0 mb-1.5">
                        <p className="ovl-menu-head">Горячие клавиши</p>
                        {KEYBINDS.map((k) => (
                          <div key={k.label} className="ovl-menu-row">
                            <Icon d={k.d} />
                            <span className="flex-1">{k.label}</span>
                            <span className="ovl-kbd">{k.keys}</span>
                          </div>
                        ))}

                        <div className="ovl-menu-sep" />

                        <button
                          type="button"
                          className="ovl-menu-toggle tip"
                          data-tip="Прячет оверлей от скриншотов и записи экрана (демонстрация, OBS, Zoom)"
                          onClick={toggleStealth}
                        >
                          <Icon d="M3 3l18 18|M10.6 5.1A9 9 0 0 1 21 12c-.5 1-1.2 2-2 2.9M6.6 6.6A9 9 0 0 0 3 12c1.7 3.3 5 5 9 5 1 0 2-.1 2.9-.4" />
                          <span className="flex-1 text-left">Скрытность (Undetectability)</span>
                          <Switch on={stealth} label="Скрытность" />
                        </button>
                        <button
                          type="button"
                          className="ovl-menu-toggle tip"
                          data-tip="Фокус остаётся в приложении под оверлеем. Внимание: ввод в поле оверлея станет недоступен"
                          onClick={toggleAvoidFocus}
                        >
                          <Icon d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0|M12 2v3|M12 19v3|M2 12h3|M19 12h3" />
                          <span className="flex-1 text-left">Не забирать фокус</span>
                          <Switch on={avoidFocus} label="Не забирать фокус" />
                        </button>

                        <div className="ovl-menu-sep" />

                        {/* Режимы ответа (как Modes у Cluely): ✓ на активном. */}
                        <button
                          type="button"
                          className="ovl-menu-toggle"
                          onClick={() => setModesOpen((v) => !v)}
                        >
                          <Icon d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <span className="flex-1 text-left">Режимы</span>
                          <span className="text-[11px] text-ink-faint">{activeMode.name}</span>
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
                                {m.name}
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
                              ✎ Управлять режимами
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
                          <span className="flex-1 text-left">Живой транскрипт</span>
                          <Switch on={showTranscript} label="Живой транскрипт" />
                        </button>

                        <p className="ovl-menu-head mt-1">Источник звука</p>
                        {(
                          [
                            ['Микрофон + система', { mic: true, system: true }],
                            ['Только микрофон', { mic: true, system: false }],
                            ['Только звук системы', { mic: false, system: true }],
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
                          Настройки SkillCue
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex-1" />
                  <button
                    type="button"
                    className="ovl-send tip"
                    data-tip="Отправить: экран + разговор (Enter)"
                    aria-label="Отправить"
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
              <div className="ovl-card mt-2 max-h-[30vh] overflow-y-auto p-3">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                  Транскрипт
                </p>
                {lines.length === 0 ? (
                  <p className="text-xs text-ink-faint">
                    Запустите запись (● в пилле) — реплики появятся здесь.
                  </p>
                ) : (
                  <div className="space-y-1 text-[12.5px]">
                    {lines.map((line, i) => (
                      <p key={i}>
                        <span
                          className={
                            line.speaker === 'me' ? 'text-violet-300' : 'text-emerald-400'
                          }
                        >
                          {line.speaker === 'me' ? 'Я: ' : 'Интервьюер: '}
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
  );
}
