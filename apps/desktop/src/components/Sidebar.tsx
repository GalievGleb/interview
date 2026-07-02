import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { WHISPER_MODEL_CARDS } from '@interview/shared';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';
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

type NavItem = { to: string; label: string; icon: IconName; live?: boolean };
type NavGroup = { title: string; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    title: 'Подготовка',
    items: [
      { to: '/home', label: 'Главная', icon: 'home' },
      { to: '/prepare', label: 'Разбор вакансии', icon: 'vacancy' },
    ],
  },
  {
    title: 'Live',
    items: [
      { to: '/interview', label: 'Live-интервью', icon: 'interview', live: true },
      { to: '/test-lab', label: 'Тестовая лаборатория', icon: 'testlab' },
    ],
  },
  {
    title: 'Библиотека',
    items: [
      { to: '/documents', label: 'Резюме и контекст', icon: 'documents' },
      { to: '/history', label: 'История', icon: 'history' },
      { to: '/meeting', label: 'Разбор разговора', icon: 'meeting' },
    ],
  },
  {
    // Benchmark/Диагностика — инструменты разработчика, доступны из Настроек.
    title: 'Система',
    items: [{ to: '/settings', label: 'Настройки', icon: 'settings' }],
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
  const { backendOnline, hasAnyKey } = useApp();
  const navigate = useNavigate();
  const sessionLive = useSessionLive();
  const [undetected, setUndetected] = useState(false);
  const [hiddenTaskbar, setHiddenTaskbar] = useState(false);
  const [model, setModel] = useState<{ label: string; mb: number; ready: boolean } | null>(null);

  useEffect(() => {
    if (!backendOnline) return;
    let alive = true;
    void (async () => {
      try {
        const s = await api.getSttSettings();
        const q = s.final_model ?? s.local_model;
        const card = WHISPER_MODEL_CARDS.find((c) => c.quality === q);
        const st = await api.sttModelStatus(q).catch(() => null);
        if (alive) {
          setModel({
            label: card?.label ?? q,
            mb: card?.approxDownloadMb ?? 0,
            ready: st?.downloaded ?? false,
          });
        }
      } catch {
        /* backend not ready */
      }
    })();
    return () => {
      alive = false;
    };
  }, [backendOnline]);

  return (
    <aside className="skillcue-sidebar">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="skillcue-logo" aria-hidden />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold tracking-tight">SkillCue</p>
          <p className="text-[11px] text-ink-faint">Пульт интервью</p>
        </div>
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('skillcue:open-palette'))}
          className="flex w-full items-center gap-2 rounded-xl border border-surface-border bg-surface/70 px-3 py-2 text-left text-sm text-ink-faint shadow-soft transition-colors hover:border-surface-border-strong hover:bg-surface-hover hover:text-ink-muted"
        >
          <Icon name="search" size={15} />
          <span className="flex-1">Поиск</span>
          <span className="sc-mono rounded-md border border-surface-border bg-surface-elevated px-1.5 py-0.5 text-[10px] text-ink-faint">
            ⌘K
          </span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 py-1">
        {GROUPS.map((group) => (
          <div key={group.title} className="mb-3">
            <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint">
              {group.title}
            </p>
            <div className="space-y-1">
              {group.items.map((item) => (
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
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.live && sessionLive && (
                        <span className="sc-ping" aria-label="session live">
                          <span className="sc-ping__halo bg-emerald-400" />
                          <span className="sc-ping__core bg-emerald-400" />
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="flex w-full items-center gap-2.5 rounded-xl border border-surface-border bg-surface-card/85 px-3 py-2.5 text-left shadow-soft transition-colors hover:border-surface-border-strong hover:bg-surface-hover"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Icon name="mic" size={16} />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
              Whisper
              <span className={`sc-dot ${model?.ready ? 'sc-dot--success' : 'sc-dot--warning'}`} />
              <span
                className={`text-[11px] font-normal ${model?.ready ? 'text-emerald-300' : 'text-ink-faint'}`}
              >
                {model ? (model.ready ? 'Готова' : 'Не загружена') : '...'}
              </span>
            </span>
            <span className="sc-mono block truncate text-[11px] text-ink-faint">
              {model ? `${model.label}${model.mb ? ` · ~${model.mb} МБ` : ''}` : 'Локальный Whisper'}
            </span>
          </span>
        </button>
      </div>

      <div className="space-y-2 border-t border-surface-border px-4 py-3">
        <StatusBadge
          label={`Backend ${backendOnline ? 'в сети' : 'не в сети'}`}
          tone={backendOnline ? 'success' : 'error'}
        />
        <StatusBadge
          label={hasAnyKey ? 'API-ключ задан' : 'Нет API-ключа'}
          tone={hasAnyKey ? 'success' : 'warning'}
        />
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
                  ? 'border-emerald-500/40 bg-emerald-900/25 text-emerald-300'
                  : 'border-surface-border text-ink-muted hover:bg-surface-hover'
              }`}
              title="Скрыть при демонстрации экрана"
            >
              <Icon name="shield" size={13} />
              {undetected ? 'Скрыто' : 'Видимо'}
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
              title="Скрыть из панели задач"
            >
              <Icon name="eye" size={13} />
              {hiddenTaskbar ? 'Без панели' : 'В панели'}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
