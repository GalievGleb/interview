import { NavLink } from 'react-router-dom';
import { useApp } from '../context/AppContext';

type IconName = 'interview' | 'meeting' | 'documents' | 'history' | 'settings';

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'interview':
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
  }
}

const GROUPS: { title: string; items: { to: string; label: string; icon: IconName }[] }[] = [
  {
    title: 'Копайлот',
    items: [
      { to: '/interview', label: 'Interview Copilot', icon: 'interview' },
      { to: '/meeting', label: 'Meeting Copilot', icon: 'meeting' },
    ],
  },
  {
    title: 'Подготовка',
    items: [
      { to: '/documents', label: 'Документы', icon: 'documents' },
      { to: '/history', label: 'История', icon: 'history' },
    ],
  },
];

export default function Sidebar() {
  const { backendOnline, hasAnyKey } = useApp();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-surface-border bg-surface-panel">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white shadow-glow">
          IC
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold tracking-tight">Interview Copilot</p>
          <p className="text-[11px] text-ink-faint">локальный AI-помощник</p>
        </div>
      </div>

      <nav className="flex-1 space-y-6 px-3 py-2">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              {group.title}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `group flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-accent-soft text-ink'
                        : 'text-ink-muted hover:bg-surface-light hover:text-ink'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className={isActive ? 'text-accent' : 'text-ink-faint group-hover:text-ink-muted'}>
                        <Icon name={item.icon} />
                      </span>
                      <span className="font-medium">{item.label}</span>
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-3 pb-2">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
              isActive ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-light hover:text-ink'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <span className={isActive ? 'text-accent' : 'text-ink-faint'}>
                <Icon name="settings" />
              </span>
              <span className="font-medium">Настройки</span>
            </>
          )}
        </NavLink>
      </div>

      <div className="space-y-2 border-t border-surface-border px-5 py-3.5 text-xs">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${backendOnline ? 'bg-emerald-400' : 'bg-red-400'}`} />
          <span className="text-ink-faint">Backend {backendOnline ? 'online' : 'offline'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${hasAnyKey ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span className="text-ink-faint">{hasAnyKey ? 'Ключ задан' : 'Нет ключа'}</span>
        </div>
      </div>
    </aside>
  );
}
