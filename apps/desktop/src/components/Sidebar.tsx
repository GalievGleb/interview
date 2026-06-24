import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import StatusBadge from './ui/StatusBadge';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

type IconName = 'interview' | 'meeting' | 'documents' | 'history' | 'settings' | 'testlab';

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 17,
    height: 17,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
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
    case 'testlab':
      return (
        <svg {...common}>
          <path d="M9 3h6v7l5 9H4l5-9V3z" />
          <path d="M10 3h4" />
        </svg>
      );
  }
}

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/interview', label: 'Interview Copilot', icon: 'interview' },
  { to: '/meeting', label: 'Meeting Copilot', icon: 'meeting' },
  { to: '/documents', label: 'Documents', icon: 'documents' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/test-lab', label: 'Test Lab', icon: 'testlab' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export default function Sidebar() {
  const { backendOnline, hasAnyKey } = useApp();
  const [undetected, setUndetected] = useState(false);
  const [hiddenTaskbar, setHiddenTaskbar] = useState(false);

  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-surface-border bg-surface-panel">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-xs font-bold text-white">
          IC
        </div>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold tracking-tight">Interview Copilot</p>
          <p className="text-[11px] text-ink-faint">AI interview assistant</p>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 px-2.5 py-1">
        {NAV.map((item) => (
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
                <span className="truncate">{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="space-y-2 border-t border-surface-border px-4 py-3">
        <StatusBadge
          label={`Backend ${backendOnline ? 'online' : 'offline'}`}
          tone={backendOnline ? 'success' : 'error'}
        />
        <StatusBadge
          label={hasAnyKey ? 'API key set' : 'No API key'}
          tone={hasAnyKey ? 'success' : 'warning'}
        />
        {isElectron && (
          <div className="space-y-1 pt-1">
            <button
              onClick={async () => {
                const next = !undetected;
                setUndetected(next);
                await window.electronAPI!.overlay.setContentProtection(next);
              }}
              className={`w-full rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                undetected
                  ? 'border-green-500/40 bg-green-900/30 text-green-400'
                  : 'border-surface-border text-ink-muted hover:bg-surface-light'
              }`}
            >
              🛡 {undetected ? 'Undetected ON' : 'Undetected OFF'}
            </button>
            <button
              onClick={async () => {
                const next = !hiddenTaskbar;
                setHiddenTaskbar(next);
                await window.electronAPI!.window.setSkipTaskbar(next);
              }}
              className={`w-full rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                hiddenTaskbar
                  ? 'border-yellow-500/40 bg-yellow-900/30 text-yellow-400'
                  : 'border-surface-border text-ink-muted hover:bg-surface-light'
              }`}
            >
              👁 {hiddenTaskbar ? 'Скрыт из taskbar' : 'Виден в taskbar'}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
