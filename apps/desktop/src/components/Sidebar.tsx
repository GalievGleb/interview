import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useI18n, type I18nKey } from '../lib/i18n';
import { useApp } from '../context/AppContext';
import { launchLive } from '../lib/launchLive';
import StatusBadge from './ui/StatusBadge';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

type IconName =
  | 'home'
  | 'vacancy'
  | 'interview'
  | 'meeting'
  | 'documents'
  | 'history'
  | 'settings'
  | 'testlab'
  | 'benchmark'
  | 'diagnostics'
  | 'search'
  | 'mic'
  | 'shield'
  | 'eye';

function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
          <path d="M9 21v-6h6v6" />
        </svg>
      );
    case 'vacancy':
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="14" rx="2" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18M11 11h2" />
        </svg>
      );
    case 'interview':
      return (
        <svg {...common}>
          <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
        </svg>
      );
    case 'meeting':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M9 13h6M9 17h6" />
        </svg>
      );
    case 'documents':
      return (
        <svg {...common}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      );
    case 'history':
      return (
        <svg {...common}>
          <path d="M3 3v5h5" />
          <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
          <path d="M12 7v5l4 2" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case 'testlab':
      return (
        <svg {...common}>
          <path d="M9 3h6v7l5 9H4l5-9V3z" />
          <path d="M10 3h4" />
        </svg>
      );
    case 'benchmark':
      return (
        <svg {...common}>
          <path d="M3 12h3l2-7 4 14 2-7h7" />
        </svg>
      );
    case 'diagnostics':
      return (
        <svg {...common}>
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case 'mic':
      return (
        <svg {...common}>
          <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...common}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case 'eye':
      return (
        <svg {...common}>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}

// launch:true — не маршрут, а действие: показать плавающий оверлей (live-режим
// больше не отдельная страница). to остаётся как fallback-маршрут для браузера.
type NavItem = { to: string; label: I18nKey; icon: IconName; live?: boolean; launch?: boolean };
type NavGroup = { title: I18nKey; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    title: 'nav.group.prep',
    items: [
      { to: '/home', label: 'nav.home', icon: 'home' },
      { to: '/prepare', label: 'nav.prepare', icon: 'vacancy' },
    ],
  },
  {
    title: 'nav.group.live',
    items: [{ to: '/overlay', label: 'nav.interview', icon: 'interview', live: true, launch: true }],
  },
  {
    title: 'nav.group.context',
    items: [
      { to: '/documents', label: 'nav.documents', icon: 'documents' },
      { to: '/history', label: 'nav.history', icon: 'history' },
    ],
  },
  {
    // Benchmark/Диагностика — инструменты разработчика, доступны из Настроек.
    title: 'nav.group.system',
    items: [{ to: '/settings', label: 'nav.settings', icon: 'settings' }],
  },
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
  const { backendOnline, backendStatus } = useApp();
  const { t } = useI18n();
  const navigate = useNavigate();
  const sessionLive = useSessionLive();
  const [undetected, setUndetected] = useState(false);
  const [hiddenTaskbar, setHiddenTaskbar] = useState(false);

  return (
    <aside className="skillcue-sidebar">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="skillcue-logo" aria-hidden />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold tracking-tight">SkillCue</p>
          <p className="text-[11px] text-ink-faint">{t('sidebar.tagline')}</p>
        </div>
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('skillcue:open-palette'))}
          className="flex w-full items-center gap-2 rounded-xl border border-surface-border bg-surface/70 px-3 py-2 text-left text-sm text-ink-faint shadow-soft transition-colors hover:border-surface-border-strong hover:bg-surface-hover hover:text-ink-muted"
        >
          <Icon name="search" size={15} />
          <span className="flex-1">{t('sidebar.quickActions')}</span>
          <span className="sc-mono rounded-md border border-surface-border bg-surface-elevated px-1.5 py-0.5 text-[10px] text-ink-faint">
            {navigator.platform.toLowerCase().includes('mac') ? '⌘K' : 'Ctrl+K'}
          </span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 py-1">
        {GROUPS.map((group) => (
          <div key={group.title} className="mb-3">
            <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              {t(group.title)}
            </p>
            <div className="space-y-1">
              {group.items.map((item) => {
                const liveDot = item.live && sessionLive && (
                  <span className="sc-ping" aria-label="session live">
                    <span className="sc-ping__halo bg-emerald-400" />
                    <span className="sc-ping__core bg-emerald-400" />
                  </span>
                );
                // Live-режим — плавающий оверлей, а не страница: рисуем кнопку,
                // которая показывает его (в браузере — fallback-переход на маршрут).
                if (item.launch) {
                  return (
                    <button
                      key={item.to}
                      type="button"
                      onClick={() => launchLive(() => navigate(item.to))}
                      className={`nav-pill w-full text-left ${
                        sessionLive ? 'nav-pill-active' : 'nav-pill-idle'
                      }`}
                    >
                      <span className={sessionLive ? 'text-accent' : 'text-ink-faint'}>
                        <Icon name={item.icon} />
                      </span>
                      <span className="flex-1 truncate">{t(item.label)}</span>
                      {liveDot}
                    </button>
                  );
                }
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `nav-pill ${isActive ? 'nav-pill-active' : 'nav-pill-idle'}`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={isActive ? 'text-accent' : 'text-ink-faint'}>
                          <Icon name={item.icon} />
                        </span>
                        <span className="flex-1 truncate">{t(item.label)}</span>
                        {liveDot}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="space-y-2 border-t border-surface-border px-4 py-3">
        {/* Ключ провайдера живёт на сервере (лицензионный гейтвей) — статус ключа
            пользователю не показываем, только готовность самого сервиса. */}
        {backendOnline ? (
          <StatusBadge label={t('sidebar.ready')} tone="success" />
        ) : backendStatus?.state === 'failed' ? (
          <StatusBadge label={t('sidebar.unavailable')} tone="error" />
        ) : null}
        {isElectron && (
          <div className="flex gap-1.5 pt-1">
            <button
              type="button"
              onClick={async () => {
                const next = !undetected;
                setUndetected(next);
                await window.electronAPI!.overlay.setContentProtection(next);
              }}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                undetected
                  ? 'border-accent/40 bg-accent-soft text-accent'
                  : 'border-surface-border text-ink-muted hover:bg-surface-hover'
              }`}
              title={t('sidebar.stealthTitle')}
            >
              <Icon name="shield" size={13} />
              {undetected ? t('sidebar.hidden') : t('sidebar.visible')}
            </button>
            <button
              type="button"
              onClick={async () => {
                const next = !hiddenTaskbar;
                setHiddenTaskbar(next);
                await window.electronAPI!.window.setSkipTaskbar(next);
              }}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                hiddenTaskbar
                  ? 'border-amber-500/40 bg-amber-900/25 text-amber-300'
                  : 'border-surface-border text-ink-muted hover:bg-surface-hover'
              }`}
              title={t('sidebar.taskbarTitle')}
            >
              <Icon name="eye" size={13} />
              {hiddenTaskbar ? t('sidebar.noTaskbar') : t('sidebar.inTaskbar')}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
