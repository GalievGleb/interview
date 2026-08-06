import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  BriefcaseBusiness,
  CalendarDays,
  EyeOff,
  FileUser,
  History,
  Mic2,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Send,
  Settings,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { useI18n, type I18nKey } from '../lib/i18n';
import { useApp } from '../context/AppContext';
import { launchLive } from '../lib/launchLive';
import type { InterviewCalendarState } from '../types/electron';
import skillCueAppIcon from '../../assets/branding/skillcue-app-icon-512.png';

const SIDEBAR_COLLAPSED_KEY = 'skillcue.sidebarCollapsed';
const STEALTH_KEY = 'skillcue.overlayStealth';
const SKIP_TASKBAR_KEY = 'skillcue.skipTaskbar';
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

const NAV_ITEMS: Array<{
  to: string;
  label: I18nKey;
  icon: typeof BriefcaseBusiness;
}> = [
  { to: '/home', label: 'nav.home', icon: BriefcaseBusiness },
  { to: '/applications', label: 'nav.applications', icon: Send },
  { to: '/calendar', label: 'nav.calendar', icon: CalendarDays },
  { to: '/documents', label: 'nav.documents', icon: FileUser },
  { to: '/history', label: 'nav.history', icon: History },
  { to: '/progress', label: 'nav.progress', icon: TrendingUp },
];

function useSessionLive(): boolean {
  const [live, setLive] = useState(false);

  useEffect(() => {
    const start = () => setLive(true);
    const stop = () => setLive(false);
    window.addEventListener('skillcue:live-start', start);
    window.addEventListener('skillcue:live-stop', stop);
    return () => {
      window.removeEventListener('skillcue:live-start', start);
      window.removeEventListener('skillcue:live-stop', stop);
    };
  }, []);

  return live;
}

export default function Sidebar() {
  const { backendStatus } = useApp();
  const { t } = useI18n();
  const navigate = useNavigate();
  const sessionLive = useSessionLive();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1',
  );
  const [undetected, setUndetected] = useState(
    () => localStorage.getItem(STEALTH_KEY) === '1',
  );
  const [hiddenTaskbar, setHiddenTaskbar] = useState(
    () => localStorage.getItem(SKIP_TASKBAR_KEY) === '1',
  );
  const [calendarAttention, setCalendarAttention] = useState(0);

  useEffect(() => {
    const calendar = window.electronAPI?.interviewCalendar;
    if (!calendar) return;
    let active = true;
    const apply = (state: InterviewCalendarState) => {
      if (!active) return;
      setCalendarAttention(
        state.scheduling.filter(
          (thread) =>
            !thread.hidden &&
            (thread.stage === 'needs_availability' || thread.stage === 'needs_attention'),
        ).length,
      );
    };
    void calendar.getState().then(apply);
    const unsubscribe = calendar.onState(apply);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
  };

  return (
    <aside className={`skillcue-sidebar ${collapsed ? 'skillcue-sidebar--collapsed' : ''}`}>
      <div className="skillcue-sidebar__brand">
        <img
          src={skillCueAppIcon}
          alt=""
          className="skillcue-logo"
          aria-hidden="true"
          draggable={false}
        />
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-tight">SkillCue</p>
          </div>
        )}
        <button
          type="button"
          className="skillcue-sidebar__icon-button ml-auto"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <div className="px-2.5 pb-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('skillcue:open-palette'))}
          className="skillcue-sidebar__search"
          aria-label={t('sidebar.quickActions')}
          title={`${t('sidebar.quickActions')} · Ctrl+K`}
        >
          <Search size={16} aria-hidden="true" />
          {!collapsed && (
            <>
              <span className="flex-1">{t('sidebar.quickActions')}</span>
              <kbd>Ctrl+K</kbd>
            </>
          )}
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2.5 py-1" aria-label={t('sidebar.mainNav')}>
        {NAV_ITEMS.map((item) => {
          const NavIcon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              title={collapsed ? t(item.label) : undefined}
              className={({ isActive }) =>
                `nav-pill relative ${isActive ? 'nav-pill-active' : 'nav-pill-idle'}`
              }
            >
              <NavIcon size={17} aria-hidden="true" />
              {!collapsed && <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>}
              {item.to === '/calendar' && calendarAttention > 0 && (
                <span
                  className={`${collapsed ? 'absolute right-1.5 top-1.5 h-2 w-2' : 'min-w-5 px-1.5 py-0.5 text-center text-[10px]'} rounded-full bg-amber-400 font-bold text-amber-950`}
                  aria-label={`Требуют внимания: ${calendarAttention}`}
                >
                  {!collapsed && Math.min(calendarAttention, 9)}
                </span>
              )}
            </NavLink>
          );
        })}

        <button
          type="button"
          onClick={() => launchLive(() => navigate('/overlay'))}
          className={`skillcue-live-launch ${sessionLive ? 'is-live' : ''}`}
          title={collapsed ? t('nav.interview') : undefined}
        >
          <Mic2 size={17} aria-hidden="true" />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate">{t('nav.interview')}</span>
              {sessionLive && (
                <span className="skillcue-live-launch__hint">{t('sidebar.liveNow')}</span>
              )}
            </>
          )}
        </button>
      </nav>

      <div className="skillcue-sidebar__footer">
        {backendStatus?.state === 'failed' && !collapsed && (
          <p className="skillcue-sidebar__error">{t('sidebar.unavailable')}</p>
        )}
        <div className="flex items-center gap-1">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `skillcue-sidebar__icon-button ${isActive ? 'is-active' : ''}`
            }
            aria-label={t('nav.settings')}
            title={t('nav.settings')}
          >
            <Settings size={16} aria-hidden="true" />
          </NavLink>

          {isElectron && (
            <>
              <button
                type="button"
                className={`skillcue-sidebar__icon-button ${undetected ? 'is-active' : ''}`}
                onClick={async () => {
                  const next = !undetected;
                  setUndetected(next);
                  localStorage.setItem(STEALTH_KEY, next ? '1' : '0');
                  await window.electronAPI!.overlay.setContentProtection(next);
                }}
                aria-pressed={undetected}
                aria-label={t('sidebar.stealthTitle')}
                title={t('sidebar.stealthTitle')}
              >
                <ShieldCheck size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`skillcue-sidebar__icon-button ${hiddenTaskbar ? 'is-active' : ''}`}
                onClick={async () => {
                  const next = !hiddenTaskbar;
                  setHiddenTaskbar(next);
                  localStorage.setItem(SKIP_TASKBAR_KEY, next ? '1' : '0');
                  await window.electronAPI!.window.setSkipTaskbar(next);
                }}
                aria-pressed={hiddenTaskbar}
                aria-label={t('sidebar.taskbarTitle')}
                title={t('sidebar.taskbarTitle')}
              >
                <EyeOff size={16} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
