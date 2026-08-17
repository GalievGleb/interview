import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import MicrophoneSettings from '../components/MicrophoneSettings';
import LicenseCard from '../components/LicenseCard';
import PlanPicker from '../components/PlanPicker';
import AnswerModesSettings from '../components/AnswerModesSettings';
import { useTheme, type ThemePref } from '../lib/theme';
import { RELEASE_NOTES } from '../lib/releaseNotes';
import { useI18n, type I18nKey } from '../lib/i18n';
import { loadLiveCopilotPrefs, saveLiveCopilotPrefs } from '../lib/liveCopilotPrefs';
import {
  ANSWER_LANGUAGE_LABELS,
  loadAnswerLanguage,
  saveAnswerLanguage,
  type AnswerLanguagePref,
} from '../lib/answerLanguage';
import { openSupportLink, SUPPORT_TELEGRAM_URL } from '../lib/support';
import { summarizePendingHhScreening } from '../lib/hhScreening';
import { shouldShowUpdateButton } from '../lib/updaterPrompt';
import type { HhAssistantState, UpdaterStatus } from '../types/electron';

/**
 * Настройки — панель в стиле Cluely: слева разделы, справа контент
 * рядами «заголовок + описание + контрол».
 */

type SettingsTab =
  | 'general'
  | 'speech'
  | 'modes'
  | 'keybinds'
  | 'billing'
  | 'notes';

const SECTIONS: Array<{ id: SettingsTab; labelKey: I18nKey; d: string }> = [
  { id: 'general', labelKey: 'settings.section.general', d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z' },
  { id: 'speech', labelKey: 'settings.section.speech', d: 'M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z|M19 10v1a7 7 0 0 1-14 0v-1|M12 18v4' },
  { id: 'modes', labelKey: 'settings.section.modes', d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' },
  { id: 'keybinds', labelKey: 'settings.section.keybinds', d: 'M2 6h20v12H2z|M6 10h.01M10 10h.01M14 10h.01M18 10h.01|M7 14h10' },
  { id: 'billing', labelKey: 'settings.section.billing', d: 'M2 6h20v12H2z|M2 10h20' },
  { id: 'notes', labelKey: 'settings.section.notes', d: 'M4 4h16v14H8l-4 4z|M8 9h8|M8 13h5' },
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
      <div className="min-w-0 basis-[200px] flex-1">
        <p className="text-[13px] font-semibold text-ink">{title}</p>
        <p className="mt-0.5 text-xs text-ink-faint">{desc}</p>
      </div>
      <div className="max-w-full min-w-0 shrink-0 overflow-x-auto">{children}</div>
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
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatus>({ state: 'idle' });
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
    const updater = window.electronAPI?.updater;
    if (!updater) return;
    let receivedLiveStatus = false;
    const unsubscribe = updater.onStatus((next) => {
      receivedLiveStatus = true;
      setUpdaterStatus(next);
    });
    void updater.getStatus?.().then((current) => {
      if (!receivedLiveStatus) setUpdaterStatus(current);
    });
    return unsubscribe;
  }, []);

  const checkUpdates = async () => {
    const check = window.electronAPI?.updater?.check;
    if (!check) {
      setUpdaterStatus({ state: 'error', message: t('settings.update.unavailable') });
      return;
    }
    setUpdaterStatus({ state: 'checking' });
    const result = await check();
    setUpdaterStatus((current) =>
      current.state === 'downloading' ||
      current.state === 'ready' ||
      current.state === 'waiting-for-session-end' ||
      current.state === 'installing'
        ? current
        : result,
    );
  };

  const canCheckUpdates =
    updaterStatus.state === 'idle' ||
    updaterStatus.state === 'none' ||
    updaterStatus.state === 'error';
  const updateMsg =
    updaterStatus.state === 'checking'
      ? t('settings.update.checking')
      : updaterStatus.state === 'available'
        ? `${t('settings.update.availablePre')} ${updaterStatus.version ?? ''} ${t('settings.update.availablePost')}`
        : updaterStatus.state === 'ready'
          ? `${t('settings.update.readyPre')} ${updaterStatus.version ?? ''} ${t('settings.update.readyPost')}`
          : updaterStatus.state === 'waiting-for-session-end'
            ? t('update.waitingForSessionEnd')
            : updaterStatus.state === 'installing'
              ? t('update.installing')
              : updaterStatus.state === 'none'
                ? updaterStatus.message ?? t('settings.update.latest')
                : updaterStatus.state === 'error'
                  ? `${t('settings.update.failed')} ${updaterStatus.message ?? t('common.error')}`
                  : '';

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
          title={`${t('settings.version')}${version ? ` ${version}` : ''}`}
          desc={t('settings.version.desc')}
        >
          <div className="flex items-center gap-3">
            {updaterStatus.state === 'downloading' ? (
              <div className="w-56">
                <p className="mb-1.5 flex items-center justify-between text-[11px] text-ink-faint">
                  <span>{t('settings.update.downloading')}</span>
                  <span className="sc-mono">{updaterStatus.percent ?? 0}%</span>
                </p>
                <div
                  className="sc-progress"
                  role="progressbar"
                  aria-label={t('settings.update.downloading')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={updaterStatus.percent ?? 0}
                >
                  <div
                    className="sc-progress__fill"
                    style={{ width: `${updaterStatus.percent ?? 0}%` }}
                  />
                </div>
              </div>
            ) : (
              updateMsg && (
                <p className="max-w-64 text-right text-[11px] text-ink-faint">{updateMsg}</p>
              )
            )}
            {canCheckUpdates && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => void checkUpdates()}
              >
                {t('settings.update.check')}
              </button>
            )}
            {shouldShowUpdateButton(updaterStatus.state) && (
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={updaterStatus.state === 'installing'}
                onClick={() => void window.electronAPI?.updater?.install()}
              >
                {t('update.apply')}
              </button>
            )}
          </div>
        </SettingRow>

        <SettingRow title={t('settings.theme.title')} desc={t('settings.theme.desc')}>
          <div className="sc-segmented" role="group" aria-label={t('settings.theme.aria')}>
            {(
              [
                ['system', t('settings.theme.system')],
                ['dark', t('settings.theme.dark')],
                ['light', t('settings.theme.light')],
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
          <SettingRow title={t('settings.autolaunch.title')} desc={t('settings.autolaunch.desc')}>
            <Toggle
              on={autoLaunch}
              label={t('settings.autolaunch.aria')}
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
          {t('settings.langGroup')}
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
        <SettingRow title={t('settings.stt.title')} desc={t('settings.stt.desc')}>
          <select
            value={sttLanguage}
            onChange={(e) => changeSttLanguage(e.target.value)}
            className="select-compact min-w-[150px]"
            aria-label={t('settings.stt.title')}
          >
            <option value="ru">{t('settings.stt.optRu')}</option>
            <option value="multi">{t('settings.stt.optAuto')}</option>
            <option value="en">{t('settings.stt.optEn')}</option>
          </select>
        </SettingRow>
        <SettingRow title={t('settings.answerLang.title')} desc={t('settings.answerLang.desc')}>
          <select
            value={answerLang}
            onChange={(e) => changeAnswerLang(e.target.value as AnswerLanguagePref)}
            className="select-compact min-w-[150px]"
            aria-label={t('settings.answerLang.title')}
          >
            {(Object.keys(ANSWER_LANGUAGE_LABELS) as AnswerLanguagePref[]).map((id) => (
              <option key={id} value={id}>
                {t(`settings.answerLang.${id}` as I18nKey)}
              </option>
            ))}
          </select>
        </SettingRow>
      </div>

      <div className="sc-card mb-5 px-5 py-1.5">
        <p className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          {t('settings.overlayGroup')}
        </p>
        <SettingRow title={t('settings.stealth.title')} desc={t('settings.stealth.desc')}>
          <Toggle on={stealth} label={t('settings.stealth.aria')} onChange={toggleStealth} />
        </SettingRow>
        <SettingRow title={t('settings.useScreen.title')} desc={t('settings.useScreen.desc')}>
          <Toggle
            on={useScreen}
            label={t('settings.useScreen.aria')}
            onChange={(v) => {
              setUseScreen(v);
              localStorage.setItem(USE_SCREEN_KEY, v ? '1' : '0');
            }}
          />
        </SettingRow>
        <SettingRow title={t('settings.hideWidget.title')} desc={t('settings.hideWidget.desc')}>
          <Toggle
            on={hideWidget}
            label={t('settings.hideWidget.title')}
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

const KEYBIND_GROUPS: Array<{ titleKey: I18nKey; items: Array<{ id: string; keys: string }> }> = [
  {
    titleKey: 'settings.kb.group.main',
    items: [
      { id: 'toggleOverlay', keys: 'Ctrl+Shift+H' },
      { id: 'ask', keys: 'Ctrl+Enter' },
      { id: 'clearChat', keys: 'Ctrl+R' },
      { id: 'stopSession', keys: 'Ctrl+Shift+\\' },
      { id: 'liveTranscript', keys: 'Ctrl+/' },
      { id: 'closeAnswer', keys: 'Esc' },
    ],
  },
  {
    titleKey: 'settings.kb.group.window',
    items: [
      { id: 'moveUp', keys: 'Ctrl+↑' },
      { id: 'moveDown', keys: 'Ctrl+↓' },
      { id: 'moveLeft', keys: 'Ctrl+←' },
      { id: 'moveRight', keys: 'Ctrl+→' },
    ],
  },
  {
    titleKey: 'settings.kb.group.scroll',
    items: [
      { id: 'scrollUp', keys: 'Ctrl+Shift+↑' },
      { id: 'scrollDown', keys: 'Ctrl+Shift+↓' },
    ],
  },
];

/** id ряда «Показать / скрыть оверлей» — единственный настраиваемый (глобальный) хоткей. */
const TOGGLE_OVERLAY_ID = 'toggleOverlay';

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
  const { t } = useI18n();
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
    if (!res.ok) setBindError(res.error ?? t('settings.kb.bindError'));
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
        {t('settings.kb.note.pre')} «{t('settings.kb.toggleOverlay')}» {t('settings.kb.note.post')}
      </p>
      {KEYBIND_GROUPS.map((group) => (
        <div key={group.titleKey} className="mb-4 last:mb-0">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            {t(group.titleKey)}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const label = t(`settings.kb.${item.id}` as I18nKey);
              const editable = item.id === TOGGLE_OVERLAY_ID && !!kb;
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-[13px] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                >
                  <span className="min-w-0 flex-1">{label}</span>
                  {editable ? (
                    <span className="flex items-center gap-2">
                      {bindError && <span className="text-[11px] text-red-400">{bindError}</span>}
                      {capturing ? (
                        <span className="animate-pulse text-[11px] text-accent">
                          {t('settings.kb.capturing')}
                        </span>
                      ) : (
                        renderKeys(acceleratorToChips(toggleAcc))
                      )}
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => setCapturing((v) => !v)}
                      >
                        {capturing ? t('common.cancel') : t('common.change')}
                      </button>
                      {toggleAcc !== defaultAcc && !capturing && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => void applyAccelerator(defaultAcc)}
                        >
                          {t('common.reset')}
                        </button>
                      )}
                    </span>
                  ) : (
                    renderKeys(item.keys.split('+'))
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
  const { t, lang } = useI18n();
  const [openVersion, setOpenVersion] = useState<string | null>(RELEASE_NOTES[0]?.version ?? null);
  // 'all' — аккордеон по всем версиям; конкретная версия — только она, раскрытая.
  const [filter, setFilter] = useState('all');
  const visibleNotes =
    filter === 'all' ? RELEASE_NOTES : RELEASE_NOTES.filter((n) => n.version === filter);
  return (
    <div className="sc-card mb-5 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          {t('settings.notes.history')}
        </p>
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            if (e.target.value !== 'all') setOpenVersion(e.target.value);
          }}
          className="select-compact min-w-[140px]"
          aria-label={t('settings.notes.versionAria')}
        >
          <option value="all">{t('settings.notes.allVersions')}</option>
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
                    {new Date(note.date).toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </span>
                </span>
                <span
                  className={`text-ink-faint transition-[transform,opacity] motion-reduce:transition-none ${
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

function AiQuotaNotice() {
  const [assistantState, setAssistantState] = useState<HhAssistantState | null>(null);
  useEffect(() => {
    const assistant = window.electronAPI?.hhAssistant;
    if (!assistant) return;
    let active = true;
    void assistant.getState().then((next) => { if (active) setAssistantState(next); }).catch(() => {});
    const unsubscribe = assistant.onState((next) => { if (active) setAssistantState(next); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const summary = summarizePendingHhScreening(assistantState?.queue ?? []);
  if (summary.quotaLimitedCount === 0) return null;
  const resetAt = new Date();
  resetAt.setMonth(resetAt.getMonth() + 1, 1);
  resetAt.setHours(0, 0, 0, 0);
  return (
    <div className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4 text-sm text-amber-100" role="status">
      <b className="block">Месячный лимит онлайн-ИИ исчерпан</b>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        Обновится {resetAt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}. До этого SkillCue продолжит автоотклики, подстановку данных из резюме и сохранённых ответов; новые личные факты попросит подтвердить вручную.
      </p>
    </div>
  );
}

/* ---------------- Страница ---------------- */

export default function SettingsPage() {
  const { t } = useI18n();
  // Deep link: /settings?tab=speech открывает нужный раздел из предупреждений.
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab') as SettingsTab | null;
  const [tab, setTab] = useState<SettingsTab>(
    requestedTab && SECTIONS.some((s) => s.id === requestedTab) ? requestedTab : 'general',
  );
  // Deep-link активация skillcue://activate?key=… приносит ключ через navigation
  // state и раскрывает раздел «Тарифы», даже если Settings уже был открыт.
  const location = useLocation();
  const activateKey = (location.state as { activateKey?: string } | null)?.activateKey;
  useEffect(() => {
    if (activateKey) setTab('billing');
  }, [activateKey]);
  // Реагируем на навигацию из оверлея («Управлять режимами» и т.п.).
  useEffect(() => {
    if (requestedTab && SECTIONS.some((s) => s.id === requestedTab)) setTab(requestedTab);
  }, [requestedTab]);
  return (
    <div className="flex max-w-6xl flex-col gap-6 lg:flex-row">
      {/* Сайдбар разделов (как панель Cluely, но в нашем стиле). */}
      <aside className="w-full shrink-0 lg:w-52">
        <div className="sticky top-4 rounded-2xl border border-surface-border bg-surface-light/70 p-2">
          <p className="px-2.5 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            {t('nav.settings')}
          </p>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={tab === s.id}
              onClick={() => {
                setTab(s.id);
                const next = new URLSearchParams(params);
                next.set('tab', s.id);
                setParams(next, { replace: true });
              }}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-semibold transition-colors ${
                tab === s.id
                  ? 'bg-surface-elevated text-ink shadow-soft'
                  : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
              }`}
            >
              <Icon d={s.d} />
              {t(s.labelKey)}
            </button>
          ))}

          {/* Единый публичный канал для связи и сообщений об ошибках. */}
          <div className="mt-2 border-t border-surface-border/60 pt-2">
            <SidebarLink
              icon="m22 2-7 20-4-9-9-4z|M22 2 11 13"
              label={t('settings.support.telegram')}
              onClick={() => openSupportLink(SUPPORT_TELEGRAM_URL)}
            />
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <h1 className="mb-1 text-lg font-bold text-ink">
          {t(SECTIONS.find((s) => s.id === tab)!.labelKey)}
        </h1>
        <p className="mb-5 text-sm text-ink-faint">{t(`settings.sub.${tab}` as I18nKey)}</p>

        {tab === 'general' && <GeneralSection />}

        {tab === 'speech' && <MicrophoneSettings />}

        {tab === 'modes' && <AnswerModesSettings />}

        {tab === 'keybinds' && <KeybindsSection />}

        {tab === 'billing' && (
          <>
            <AiQuotaNotice />
            <LicenseCard autoActivateKey={activateKey} />
            <PlanPicker />
          </>
        )}

        {tab === 'notes' && <ReleaseNotesSection />}
      </div>
    </div>
  );
}
