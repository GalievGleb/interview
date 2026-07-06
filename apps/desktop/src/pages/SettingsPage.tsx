import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';
import Modal from '../components/Modal';
import MicrophoneSettings from '../components/MicrophoneSettings';
import AiModelsSettings from '../components/AiModelsSettings';
import SpeechRecognitionSettings from '../components/SpeechRecognitionSettings';
import DiagnosticsPanel from '../components/DiagnosticsPanel';
import UsageCard from '../components/UsageCard';
import LicenseCard from '../components/LicenseCard';
import PlanPicker from '../components/PlanPicker';
import AnswerModesSettings from '../components/AnswerModesSettings';
import { useTheme, type ThemePref } from '../lib/theme';
import { RELEASE_NOTES } from '../lib/releaseNotes';
import { useI18n } from '../lib/i18n';
import { loadLiveCopilotPrefs, saveLiveCopilotPrefs } from '../lib/liveCopilotPrefs';
import {
  ANSWER_LANGUAGE_LABELS,
  loadAnswerLanguage,
  saveAnswerLanguage,
  type AnswerLanguagePref,
} from '../lib/answerLanguage';
import { openSupportLink, SUPPORT_EMAIL, SUPPORT_TELEGRAM_URL } from '../lib/support';

/**
 * Настройки — панель в стиле Cluely: слева разделы, справа контент
 * рядами «заголовок + описание + контрол». Deep-links (?tab=ai|speech|…)
 * сохранены для предупреждений с других экранов.
 */

type SettingsTab =
  | 'general'
  | 'ai'
  | 'speech'
  | 'modes'
  | 'keybinds'
  | 'billing'
  | 'privacy'
  | 'developer'
  | 'notes';

const SECTIONS: Array<{ id: SettingsTab; label: string; d: string }> = [
  { id: 'general', label: 'Общие', d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z' },
  { id: 'ai', label: 'ИИ и модели', d: 'M12 2a4 4 0 0 1 4 4c0 .74-.2 1.43-.55 2.03A4 4 0 0 1 18 12a4 4 0 0 1-2 3.46V17a4 4 0 0 1-8 0v-1.54A4 4 0 0 1 6 12a4 4 0 0 1 2.55-3.97A4 4 0 0 1 8 6a4 4 0 0 1 4-4z' },
  { id: 'speech', label: 'Речь и звук', d: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z|M19 10v1a7 7 0 0 1-14 0v-1|M12 18v4' },
  { id: 'modes', label: 'Режимы ответа', d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { id: 'keybinds', label: 'Горячие клавиши', d: 'M2 6h20v12H2z|M6 10h.01M10 10h.01M14 10h.01M18 10h.01|M7 14h10' },
  { id: 'billing', label: 'Подписка', d: 'M2 6h20v12H2z|M2 10h20' },
  { id: 'privacy', label: 'Приватность', d: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z' },
  { id: 'developer', label: 'Разработчик', d: 'm8 8-4 4 4 4|m16 8 4 4-4 4|m12 4-2 16' },
  { id: 'notes', label: 'Что нового', d: 'M4 4h16v14H8l-4 4z|M8 9h8|M8 13h5' },
];

const STEALTH_KEY = 'skillcue.overlayStealth';
const USE_SCREEN_KEY = 'skillcue.overlayUseScreen';
const HIDE_WIDGET_KEY = 'skillcue.overlayHideWidget';

function Icon({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {d.split('|').map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

/** Внешняя ссылка в сайдбаре настроек: иконка + подпись + стрелка ↗. */
function SidebarLink({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-semibold text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
    >
      <Icon d={icon} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-ink-faint opacity-60 transition-opacity group-hover:opacity-100">
        <Icon d="M7 17 17 7|M8 7h9v9" size={12} />
      </span>
    </button>
  );
}

/** Ряд настройки: заголовок + описание слева, контрол справа (как у Cluely). */
function SettingRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    // flex-wrap: на минимальной ширине окна контрол уходит под текст,
    // а не давит колонку заголовка до нечитаемой ширины.
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-surface-border/60 py-3.5 last:border-b-0">
      <div className="min-w-[200px] flex-1">
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <p className="mt-0.5 text-xs text-ink-faint">{desc}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-[22px] w-[40px] rounded-full transition-colors ${
        on ? 'bg-accent' : 'bg-surface-border-strong'
      }`}
    >
      <span
        className={`absolute left-0 top-[3px] h-4 w-4 rounded-full bg-white transition-transform ${
          on ? 'translate-x-[21px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

/* ---------------- Общие ---------------- */

function GeneralSection() {
  const { pref, setPref } = useTheme();
  const { t, lang, setLang } = useI18n();
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const [stealth, setStealth] = useState(() => localStorage.getItem(STEALTH_KEY) === '1');
  const [useScreen, setUseScreen] = useState(() => localStorage.getItem(USE_SCREEN_KEY) !== '0');
  const [hideWidget, setHideWidget] = useState(() => localStorage.getItem(HIDE_WIDGET_KEY) !== '0');
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [autoLaunchAvailable, setAutoLaunchAvailable] = useState(false);
  // Язык распознавания живёт в prefs Live-экрана — здесь просто вторая ручка.
  const [sttLanguage, setSttLanguage] = useState(() => loadLiveCopilotPrefs().language);
  const [answerLang, setAnswerLang] = useState<AnswerLanguagePref>(loadAnswerLanguage);

  useEffect(() => {
    void window.electronAPI?.getVersion?.().then((v) => setVersion(v));
    const get = window.electronAPI?.getAutoLaunch;
    if (get) {
      setAutoLaunchAvailable(true);
      void get().then(setAutoLaunch);
    }
  }, []);

  const checkUpdates = async () => {
    const check = window.electronAPI?.updater?.check;
    if (!check) {
      setUpdateMsg('Проверка обновлений доступна в установленном приложении.');
      return;
    }
    setChecking(true);
    setUpdateMsg('');
    try {
      const res = await check();
      if (res.state === 'available') {
        setUpdateMsg(`Доступна версия ${res.version} — скачивается в фоне.`);
      } else if (res.state === 'none') {
        setUpdateMsg(res.message ?? 'У вас последняя версия.');
      } else {
        setUpdateMsg(`Не удалось проверить: ${res.message ?? 'ошибка'}`);
      }
    } finally {
      setChecking(false);
    }
  };

  const toggleStealth = (v: boolean) => {
    setStealth(v);
    localStorage.setItem(STEALTH_KEY, v ? '1' : '0');
    void window.electronAPI?.overlay.setContentProtection?.(v);
  };

  const changeSttLanguage = (v: string) => {
    setSttLanguage(v);
    saveLiveCopilotPrefs({ ...loadLiveCopilotPrefs(), language: v });
  };

  const changeAnswerLang = (v: AnswerLanguagePref) => {
    setAnswerLang(v);
    saveAnswerLanguage(v);
  };

  return (
    <>
      <div className="sc-card mb-5 px-5 py-1.5">
        <SettingRow
          title={`Версия SkillCue${version ? ` ${version}` : ''}`}
          desc="Обновления скачиваются в фоне и ставятся при перезапуске"
        >
          <div className="flex items-center gap-3">
            {updateMsg && <p className="max-w-56 text-right text-[11px] text-ink-faint">{updateMsg}</p>}
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={checking}
              onClick={() => void checkUpdates()}
            >
              {checking ? 'Проверяю…' : 'Проверить обновления'}
            </button>
          </div>
        </SettingRow>

        <SettingRow title="Тема оформления" desc="Тёмная, светлая или как в системе">
          <div className="sc-segmented" role="group" aria-label="Тема">
            {(
              [
                ['system', 'Системная'],
                ['dark', 'Тёмная'],
                ['light', 'Светлая'],
              ] as Array<[ThemePref, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setPref(id)}
                className={`sc-segmented__item ${pref === id ? 'sc-segmented__item--active' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>

        {autoLaunchAvailable && (
          <SettingRow
            title="Запускать при входе в систему"
            desc="SkillCue откроется автоматически после включения компьютера"
          >
            <Toggle
              on={autoLaunch}
              label="Автозапуск"
              onChange={(v) => {
                setAutoLaunch(v);
                void window.electronAPI?.setAutoLaunch?.(v);
              }}
            />
          </SettingRow>
        )}
      </div>

      <div className="sc-card mb-5 px-5 py-1.5">
        <p className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Язык
        </p>
        <SettingRow title={t('settings.language.title')} desc={t('settings.language.subtitle')}>
          <div className="sc-segmented" role="group" aria-label={t('common.language')}>
            {(['ru', 'en'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`sc-segmented__item ${lang === l ? 'sc-segmented__item--active' : ''}`}
              >
                {l === 'ru' ? 'Русский' : 'English'}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          title="Язык распознавания речи"
          desc="Каким языком говорят на собеседовании; дублируется на экране Live"
        >
          <select
            value={sttLanguage}
            onChange={(e) => changeSttLanguage(e.target.value)}
            className="select-compact min-w-[150px]"
            aria-label="Язык распознавания речи"
          >
            <option value="ru">Русский</option>
            <option value="multi">Авто (ru+en)</option>
            <option value="en">Английский</option>
          </select>
        </SettingRow>
        <SettingRow
          title="Язык ответов ИИ"
          desc="На каком языке подсказки формулируют ответ; «Авто» — на языке вопроса"
        >
          <select
            value={answerLang}
            onChange={(e) => changeAnswerLang(e.target.value as AnswerLanguagePref)}
            className="select-compact min-w-[150px]"
            aria-label="Язык ответов ИИ"
          >
            {(Object.keys(ANSWER_LANGUAGE_LABELS) as AnswerLanguagePref[]).map((id) => (
              <option key={id} value={id}>
                {ANSWER_LANGUAGE_LABELS[id]}
              </option>
            ))}
          </select>
        </SettingRow>
      </div>

      <div className="sc-card mb-5 px-5 py-1.5">
        <p className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Оверлей
        </p>
        <SettingRow
          title="Скрытность (Undetectability)"
          desc="Оверлей не виден на скриншотах, записи экрана и демонстрации в Zoom/Meet"
        >
          <Toggle on={stealth} label="Скрытность" onChange={toggleStealth} />
        </SettingRow>
        <SettingRow
          title="Смотреть экран при нехватке контекста"
          desc="Если разговора нет, Подсказка сама делает скриншот и отвечает по нему (чуть медленнее)"
        >
          <Toggle
            on={useScreen}
            label="Анализ экрана"
            onChange={(v) => {
              setUseScreen(v);
              localStorage.setItem(USE_SCREEN_KEY, v ? '1' : '0');
            }}
          />
        </SettingRow>
        <SettingRow
          title="«Скрыть» прячет весь виджет"
          desc="Выключите — кнопка «Скрыть» будет сворачивать панели до пилла, а не прятать всё окно"
        >
          <Toggle
            on={hideWidget}
            label="«Скрыть» прячет весь виджет"
            onChange={(v) => {
              setHideWidget(v);
              localStorage.setItem(HIDE_WIDGET_KEY, v ? '1' : '0');
            }}
          />
        </SettingRow>
      </div>
    </>
  );
}

/* ---------------- Горячие клавиши ---------------- */

const KEYBIND_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: 'Основные',
    items: [
      ['Показать / скрыть оверлей', 'Ctrl+Shift+H'],
      ['Спросить (Подсказка)', 'Ctrl+Enter'],
      ['Очистить чат оверлея', 'Ctrl+R'],
      ['Остановить сессию записи', 'Ctrl+Shift+\\'],
      ['Живой транскрипт', 'Ctrl+/'],
      ['Закрыть ответ / меню', 'Esc'],
    ],
  },
  {
    title: 'Окно оверлея',
    items: [
      ['Сдвинуть вверх', 'Ctrl+↑'],
      ['Сдвинуть вниз', 'Ctrl+↓'],
      ['Сдвинуть влево', 'Ctrl+←'],
      ['Сдвинуть вправо', 'Ctrl+→'],
    ],
  },
  {
    title: 'Прокрутка ответа',
    items: [
      ['Прокрутить вверх', 'Ctrl+Shift+↑'],
      ['Прокрутить вниз', 'Ctrl+Shift+↓'],
    ],
  },
];

/** Метка «Показать / скрыть оверлей» — единственный настраиваемый (глобальный) хоткей. */
const TOGGLE_OVERLAY_LABEL = 'Показать / скрыть оверлей';

function acceleratorToChips(acc: string): string[] {
  return acc.split('+').map((k) => (k === 'CommandOrControl' ? 'Ctrl' : k));
}

/** KeyboardEvent → Electron accelerator; null, если сочетание не годится.
 *  Буквы/цифры берём из e.code (физическая клавиша): с русской раскладкой
 *  e.key даёт «Р», которую Electron-акселератор не принимает. */
function eventToAccelerator(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  // Глобальный хоткей без модификатора перехватывал бы обычный ввод.
  if (mods.length === 0) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (e.key === ' ') key = 'Space';
  else if (e.key.startsWith('Arrow')) key = e.key.slice(5);
  else if (/^F\d{1,2}$|^(Home|End|PageUp|PageDown|Insert|Delete|Backspace|Tab|Enter)$/.test(e.key))
    key = e.key;
  else if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) key = e.key.toUpperCase();
  else return null;
  return [...mods, key].join('+');
}

function KeybindsSection() {
  const kb = window.electronAPI?.keybinds;
  const [toggleAcc, setToggleAcc] = useState('CommandOrControl+Shift+H');
  const [defaultAcc, setDefaultAcc] = useState('CommandOrControl+Shift+H');
  const [capturing, setCapturing] = useState(false);
  const [bindError, setBindError] = useState('');

  useEffect(() => {
    void kb?.get().then((info) => {
      setToggleAcc(info.toggleOverlay);
      setDefaultAcc(info.defaultToggleOverlay);
    });
    // kb стабилен на всю жизнь окна (preload).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyAccelerator = async (acc: string) => {
    if (!kb) return;
    setBindError('');
    const res = await kb.setToggleOverlay(acc);
    setToggleAcc(res.shortcut);
    if (!res.ok) setBindError(res.error ?? 'Не удалось назначить сочетание');
  };

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(false);
        return;
      }
      const acc = eventToAccelerator(e);
      if (!acc) return; // ждём полное сочетание с модификатором
      setCapturing(false);
      void applyAccelerator(acc);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
    // applyAccelerator пересоздаётся, но слушателю нужен только свежий вызов.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  const renderKeys = (keys: string[]) => (
    <span className="flex gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="rounded-md border border-surface-border bg-surface-light px-1.5 py-0.5 font-mono text-[11px] text-ink-muted"
        >
          {k}
        </kbd>
      ))}
    </span>
  );

  return (
    <div className="sc-card mb-5 p-5">
      <p className="mb-4 text-xs text-ink-faint">
        Горячие клавиши работают, когда окно оверлея в фокусе; «{TOGGLE_OVERLAY_LABEL}» — глобальная
        и настраивается, если системное сочетание конфликтует с другим приложением.
      </p>
      {KEYBIND_GROUPS.map((group) => (
        <div key={group.title} className="mb-4 last:mb-0">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            {group.title}
          </p>
          <div className="space-y-0.5">
            {group.items.map(([label, keys]) => {
              const editable = label === TOGGLE_OVERLAY_LABEL && !!kb;
              return (
                <div
                  key={label}
                  className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                >
                  <span className="min-w-0 flex-1">{label}</span>
                  {editable ? (
                    <span className="flex items-center gap-2">
                      {bindError && <span className="text-[11px] text-red-400">{bindError}</span>}
                      {capturing ? (
                        <span className="animate-pulse text-[11px] text-accent">
                          Нажмите сочетание… (Esc — отмена)
                        </span>
                      ) : (
                        renderKeys(acceleratorToChips(toggleAcc))
                      )}
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => setCapturing((v) => !v)}
                      >
                        {capturing ? 'Отмена' : 'Изменить'}
                      </button>
                      {toggleAcc !== defaultAcc && !capturing && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => void applyAccelerator(defaultAcc)}
                        >
                          Сбросить
                        </button>
                      )}
                    </span>
                  ) : (
                    renderKeys(keys.split('+'))
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Что нового ---------------- */

function ReleaseNotesSection() {
  const [openVersion, setOpenVersion] = useState<string | null>(RELEASE_NOTES[0]?.version ?? null);
  // 'all' — аккордеон по всем версиям; конкретная версия — только она, раскрытая.
  const [filter, setFilter] = useState('all');
  const visibleNotes =
    filter === 'all' ? RELEASE_NOTES : RELEASE_NOTES.filter((n) => n.version === filter);
  return (
    <div className="sc-card mb-5 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          История версий
        </p>
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            if (e.target.value !== 'all') setOpenVersion(e.target.value);
          }}
          className="select-compact min-w-[140px]"
          aria-label="Версия"
        >
          <option value="all">Все версии</option>
          {RELEASE_NOTES.map((n) => (
            <option key={n.version} value={n.version}>
              v{n.version}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        {visibleNotes.map((note) => {
          const open = filter !== 'all' || openVersion === note.version;
          return (
            <div key={note.version}>
              <button
                type="button"
                className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface-hover"
                onClick={() => setOpenVersion(open ? null : note.version)}
              >
                <span className="sc-badge sc-badge--accent shrink-0">v{note.version}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-ink">
                    {note.title}
                  </span>
                  <span className="block text-[11px] text-ink-faint">
                    {new Date(note.date).toLocaleDateString('ru-RU', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </span>
                </span>
                <span
                  className={`text-ink-faint transition-all ${
                    open ? 'rotate-90' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  →
                </span>
              </button>
              {open && (
                <ul className="mb-2 ml-4 mt-1 list-disc space-y-1 pl-4 text-[12.5px] text-ink-muted">
                  {note.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Страница ---------------- */

export default function SettingsPage() {
  const { keys, refreshKeys } = useApp();
  const navigate = useNavigate();
  // Deep link: /settings?tab=speech открывает нужный раздел из предупреждений.
  const [params] = useSearchParams();
  const requestedTab = params.get('tab') as SettingsTab | null;
  const [tab, setTab] = useState<SettingsTab>(
    requestedTab && SECTIONS.some((s) => s.id === requestedTab) ? requestedTab : 'general',
  );
  const [openai, setOpenai] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reporting, setReporting] = useState(false);

  // «Сообщить о проблеме»: main собирает zip (логи бэкенда + system info +
  // эти prefs), показывает его в проводнике, а мы открываем письмо в поддержку.
  const reportProblem = async () => {
    const collect = window.electronAPI?.collectDiagnostics;
    if (!collect) {
      openSupportLink(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('SkillCue: проблема')}`);
      return;
    }
    setReporting(true);
    try {
      const prefs: Record<string, string> = {};
      for (const key of [
        'skillcue.theme',
        'skillcue.lang',
        'skillcue.answerLanguage',
        'copilot-live-prefs',
        'fast-answer',
        'skillcue:lastTimings',
      ]) {
        const v = localStorage.getItem(key);
        if (v !== null) prefs[key] = v;
      }
      await collect([{ name: 'prefs.json', content: JSON.stringify(prefs, null, 2) }]);
      openSupportLink(
        `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('SkillCue: проблема')}&body=${encodeURIComponent(
          'Опишите, что случилось и в какой момент.\n\nПриложите zip-архив отчёта — он уже открыт в проводнике.',
        )}`,
      );
    } finally {
      setReporting(false);
    }
  };

  // Реагируем на навигацию из оверлея («Управлять режимами» и т.п.).
  useEffect(() => {
    if (requestedTab && SECTIONS.some((s) => s.id === requestedTab)) setTab(requestedTab);
  }, [requestedTab]);

  const save = async () => {
    if (!openai) {
      setMessage('Нечего сохранять — введите ключ');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      await api.saveKeys({ openai_api_key: openai });
      setOpenai('');
      await refreshKeys();
      setMessage('Ключ OpenAI обновлён');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSaving(false);
    }
  };

  const deleteData = async () => {
    try {
      await api.deleteAllData();
      setMessage('Все данные удалены');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setConfirmDelete(false);
    }
  };

  return (
    <div className="flex max-w-6xl gap-6">
      {/* Сайдбар разделов (как панель Cluely, но в нашем стиле). */}
      <aside className="w-52 shrink-0">
        <div className="sticky top-4 rounded-2xl border border-surface-border bg-surface-light/70 p-2">
          <p className="px-2.5 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Настройки
          </p>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setTab(s.id)}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-semibold transition-colors ${
                tab === s.id
                  ? 'bg-surface-elevated text-ink shadow-soft'
                  : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
              }`}
            >
              <Icon d={s.d} />
              {s.label}
            </button>
          ))}

          {/* Справка и выход — как нижний блок настроек Cluely. */}
          <div className="mt-2 border-t border-surface-border/60 pt-2">
            <SidebarLink
              icon="M12 8v4|M12 16h.01|M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"
              label={reporting ? 'Собираю отчёт…' : 'Сообщить о проблеме'}
              onClick={() => void reportProblem()}
            />
            <SidebarLink
              icon="M4 6h16v12H4z|m4 7 8 6 8-6"
              label="Написать в поддержку"
              onClick={() => openSupportLink(`mailto:${SUPPORT_EMAIL}`)}
            />
            <SidebarLink
              icon="m22 2-7 20-4-9-9-4z|M22 2 11 13"
              label="Telegram-чат"
              onClick={() => openSupportLink(SUPPORT_TELEGRAM_URL)}
            />
            {!!window.electronAPI?.quit && (
              <button
                type="button"
                onClick={() => void window.electronAPI?.quit?.()}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-semibold text-ink-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                <Icon d="M12 2v10|M18.36 6.64a9 9 0 1 1-12.72 0" />
                Выйти из SkillCue
              </button>
            )}
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <h1 className="mb-1 text-lg font-bold text-ink">
          {SECTIONS.find((s) => s.id === tab)?.label}
        </h1>
        <p className="mb-5 text-sm text-ink-faint">
          {tab === 'general' && 'Версия, тема, язык и поведение оверлея.'}
          {tab === 'ai' && 'Ключи, модели для live-подсказок и разбора вакансий.'}
          {tab === 'speech' && 'Whisper, качество записи и микрофон.'}
          {tab === 'modes' && 'Пресеты стиля ответов для оверлея.'}
          {tab === 'keybinds' && 'Все сочетания клавиш приложения и оверлея.'}
          {tab === 'billing' && 'Тариф, лицензия и расход токенов.'}
          {tab === 'privacy' && 'Данные, лицензии open-source, удаление.'}
          {tab === 'developer' && 'Отладка STT, задержек и voice-регрессий.'}
          {tab === 'notes' && 'История версий SkillCue.'}
        </p>

        {tab === 'general' && <GeneralSection />}

        {tab === 'ai' && (
          <>
            <AiModelsSettings />
            <div className="card mb-5 space-y-4 p-5">
              <div>
                <h3 className="text-sm font-semibold text-ink">Дополнительный OpenAI-ключ</h3>
                <p className="mt-0.5 text-sm text-ink-muted">
                  Основной поток работает через OpenRouter. Этот ключ нужен только для отдельных
                  fallback-сценариев.
                </p>
              </div>
              <div>
                <label className="label">OpenAI API Key</label>
                <input
                  type="password"
                  name="openai_api_key"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={keys?.openai ? '•••••••• (задан)' : 'sk-…'}
                  value={openai}
                  onChange={(e) => setOpenai(e.target.value)}
                  className="field"
                />
              </div>
              <div className="flex items-center gap-3 pt-1">
                <button onClick={() => void save()} disabled={saving} className="btn-primary">
                  {saving ? 'Сохраняю…' : 'Сохранить ключ'}
                </button>
                {message && <p className="text-sm text-emerald-400">{message}</p>}
              </div>
            </div>
          </>
        )}

        {tab === 'speech' && (
          <>
            <SpeechRecognitionSettings />
            <MicrophoneSettings />
          </>
        )}

        {tab === 'modes' && <AnswerModesSettings />}

        {tab === 'keybinds' && <KeybindsSection />}

        {tab === 'billing' && (
          <>
            <PlanPicker />
            <LicenseCard />
            <UsageCard />
          </>
        )}

        {tab === 'privacy' && (
          <>
            <div className="card mb-5 flex items-center justify-between gap-4 p-5">
              <div>
                <h3 className="text-sm font-semibold text-ink">Открытое ПО и лицензии</h3>
                <p className="mt-0.5 text-sm text-ink-muted">
                  Уведомления о лицензиях встроенных open-source компонентов.
                </p>
              </div>
              <button
                type="button"
                onClick={() => navigate('/licenses')}
                className="btn-secondary btn-sm"
              >
                Открыть
              </button>
            </div>

            <div className="rounded-2xl border border-red-900/40 bg-red-950/10 p-5">
              <h3 className="mb-1 text-sm font-semibold text-red-300">Удаление данных</h3>
              <p className="mb-4 text-sm text-ink-muted">
                Документы, сессии и история хранятся локально. Можно удалить их одной кнопкой.
                API-ключи останутся в secure storage.
              </p>
              <button onClick={() => setConfirmDelete(true)} className="btn-danger">
                Удалить все данные
              </button>
              {message && <p className="mt-3 text-sm text-emerald-400">{message}</p>}
            </div>
          </>
        )}

        {tab === 'developer' && (
          <>
            <div className="card mb-5 p-5">
              <h3 className="text-sm font-semibold text-ink">Инструменты разработчика</h3>
              <p className="mt-0.5 mb-3 text-sm text-ink-muted">
                Эти экраны нужны для отладки STT, latency и voice regression. В обычной подготовке
                они не участвуют.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => navigate('/test-lab')}
                  className="btn-secondary btn-sm"
                >
                  Тестовая лаборатория
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/benchmark')}
                  className="btn-secondary btn-sm"
                >
                  STT-бенчмарк
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/diagnostics')}
                  className="btn-secondary btn-sm"
                >
                  Диагностика задержек
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/meeting')}
                  className="btn-secondary btn-sm"
                >
                  Разбор разговора
                </button>
              </div>
            </div>
            <DiagnosticsPanel />
          </>
        )}

        {tab === 'notes' && <ReleaseNotesSection />}
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Удалить все данные?"
        subtitle="Документы, сессии и история будут удалены безвозвратно."
        footer={
          <>
            <button onClick={() => setConfirmDelete(false)} className="btn-secondary btn-sm">
              Отмена
            </button>
            <button onClick={() => void deleteData()} className="btn-danger btn-sm">
              Удалить
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Это действие нельзя отменить. API-ключи останутся в secure storage.
        </p>
      </Modal>
    </div>
  );
}
