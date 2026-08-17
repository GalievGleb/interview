import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  BookOpenCheck,
  BriefcaseBusiness,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  FileUser,
  Dumbbell,
  History,
  House,
  Mic2,
  Send,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { useI18n, type I18nKey } from '../lib/i18n';
import { useApp } from '../context/AppContext';
import { launchLive } from '../lib/launchLive';
import type { InterviewCalendarEvent, InterviewCalendarState } from '../types/electron';
import skillCueAppIcon from '../../assets/branding/skillcue-app-icon-512.png';

const SIDEBAR_COLLAPSED_KEY = 'skillcue.sidebarCollapsed';
const STEALTH_KEY = 'skillcue.overlayStealth';
const SKIP_TASKBAR_KEY = 'skillcue.skipTaskbar';

const NAV_ITEMS: Array<{
  to: string;
  label: I18nKey;
  icon: typeof BriefcaseBusiness;
}> = [
  { to: '/home', label: 'nav.home', icon: House },
  { to: '/prepare', label: 'nav.prepare', icon: BookOpenCheck },
  { to: '/applications', label: 'nav.applications', icon: Send },
  { to: '/calendar', label: 'nav.calendar', icon: CalendarDays },
  { to: '/documents', label: 'nav.documents', icon: FileUser },
  { to: '/practice', label: 'nav.practice', icon: Dumbbell },
  { to: '/history', label: 'nav.history', icon: History },
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
  const [compactViewport, setCompactViewport] = useState(
    () => window.matchMedia('(max-width: 45rem)').matches,
  );
  const [undetected, setUndetected] = useState(
    () => localStorage.getItem(STEALTH_KEY) === '1',
  );
  const [hiddenTaskbar, setHiddenTaskbar] = useState(
    () => localStorage.getItem(SKIP_TASKBAR_KEY) === '1',
  );
  const [calendarAttention, setCalendarAttention] = useState(0);
  const [upcomingInterview, setUpcomingInterview] = useState<InterviewCalendarEvent | null>(null);
  const visuallyCollapsed = collapsed || compactViewport;

  useEffect(() => {
    const media = window.matchMedia('(max-width: 45rem)');
    const update = () => setCompactViewport(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

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
      const now = Date.now();
      const nearest = state.events
        .filter((event) => event.status !== 'cancelled' && !event.completedAt && +new Date(event.endAt) >= now)
        .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt))[0] ?? null;
      setUpcomingInterview(
        nearest && +new Date(nearest.startAt) - now <= 72 * 60 * 60 * 1000 ? nearest : null,
      );
    };
    void calendar.getState().then(apply).catch(() => {
      // Календарь не должен ломать основную навигацию при временной ошибке фонового сервиса.
    });
    const unsubscribe = calendar.onState(apply);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };

  const launchUpcomingLive = async () => {
    const launchForEvent = window.electronAPI?.overlay.showForInterviewEvent;
    if (upcomingInterview && launchForEvent) {
      const opened = await launchForEvent(upcomingInterview.id);
      if (opened !== false) return;
    }
    launchLive(() => navigate('/overlay'));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== '\\') return;
      event.preventDefault();
      toggleCollapsed();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <aside className={`skillcue-sidebar ${visuallyCollapsed ? 'skillcue-sidebar--collapsed' : ''}`}>
      {!compactViewport && <button
        type="button"
        className="skillcue-sidebar__collapse"
        onClick={toggleCollapsed}
        aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        aria-keyshortcuts="Control+Backslash"
        title={`${collapsed ? t('sidebar.expand') : t('sidebar.collapse')} · Ctrl+\\`}
      >
        {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
      </button>}
      <div className="skillcue-sidebar__brand">
        <img
          src={skillCueAppIcon}
          alt=""
          width={36}
          height={36}
          className="skillcue-logo"
          aria-hidden="true"
          draggable={false}
        />
        {!visuallyCollapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold tracking-tight">SkillCue</p>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2.5 py-2" aria-label={t('sidebar.mainNav')}>
        {NAV_ITEMS.map((item) => {
          const NavIcon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              title={visuallyCollapsed ? t(item.label) : undefined}
              className={({ isActive }) =>
                `nav-pill relative ${isActive ? 'nav-pill-active' : 'nav-pill-idle'}`
              }
            >
              <NavIcon size={17} aria-hidden="true" />
              {!visuallyCollapsed && <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>}
              {item.to === '/calendar' && calendarAttention > 0 && (
                <span
                  className={`${visuallyCollapsed ? 'absolute right-1.5 top-1.5 h-2 w-2' : 'min-w-5 px-1.5 py-0.5 text-center text-xs'} rounded-full bg-sky-400/20 font-bold text-sky-200 ring-1 ring-inset ring-sky-300/25`}
                  aria-label={`Требуют внимания: ${calendarAttention}`}
                >
                  {!visuallyCollapsed && Math.min(calendarAttention, 9)}
                </span>
              )}
            </NavLink>
          );
        })}

      </nav>

      <div className="skillcue-sidebar__live-zone">
        <button
          type="button"
          onClick={() => void launchUpcomingLive()}
          className={`skillcue-live-launch ${sessionLive ? 'is-live' : ''}`}
          title={visuallyCollapsed ? t('sidebar.openLiveOverlay') : undefined}
          aria-label={t('sidebar.openLiveOverlay')}
        >
          <Mic2 size={17} aria-hidden="true" />
          {!visuallyCollapsed && (
            <>
              <span className="min-w-0 flex-1 truncate">{t('sidebar.openLiveOverlay')}</span>
              {sessionLive && (
                <span className="skillcue-live-launch__hint">{t('sidebar.liveNow')}</span>
              )}
            </>
          )}
        </button>
      </div>

      <div className="skillcue-sidebar__footer">
        {backendStatus?.state === 'failed' && !visuallyCollapsed && (
          <p className="skillcue-sidebar__error">{t('sidebar.unavailable')}</p>
        )}
        <div className="skillcue-sidebar__utility-row" aria-label="Служебные действия">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `skillcue-sidebar__icon-button ${isActive ? 'is-active' : ''}`
            }
            aria-label={t('nav.settings')}
            title={t('nav.settings')}
          >
            <Settings size={17} aria-hidden="true" />
          </NavLink>
          <button
            type="button"
            className={`skillcue-sidebar__icon-button ${undetected ? 'is-active' : ''}`}
            onClick={async () => {
              const next = !undetected;
              setUndetected(next);
              localStorage.setItem(STEALTH_KEY, next ? '1' : '0');
              try {
                await window.electronAPI?.overlay.setContentProtection(next);
              } catch {
                setUndetected(!next);
                localStorage.setItem(STEALTH_KEY, !next ? '1' : '0');
              }
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
              try {
                await window.electronAPI?.window.setSkipTaskbar(next);
              } catch {
                setHiddenTaskbar(!next);
                localStorage.setItem(SKIP_TASKBAR_KEY, !next ? '1' : '0');
              }
            }}
            aria-pressed={hiddenTaskbar}
            aria-label={t('sidebar.taskbarTitle')}
            title={t('sidebar.taskbarTitle')}
          >
            <EyeOff size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}
