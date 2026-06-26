import { ReactNode, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import CommandPalette from './CommandPalette';
import { useApp } from '../context/AppContext';

const WIDE_ROUTES = new Set(['/interview', '/meeting']);
const NO_TITLEBAR_ROUTES = new Set(['/meeting']);

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function TitleBar({ onInterview }: { onInterview: boolean }) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header className="flex h-[50px] shrink-0 items-center gap-3 border-b border-surface-border bg-surface-panel px-4">
      <div className="flex items-center gap-1.5">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]/70" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]/70" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]/70" />
      </div>

      <div className="ml-1 flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-[10px] font-bold text-white">
          SC
        </div>
        <span className="text-sm font-semibold tracking-tight text-ink">SkillCue</span>
        <span className="sc-mono rounded-md border border-surface-border bg-surface-elevated px-1.5 py-0.5 text-[10px] text-ink-faint">
          2.0
        </span>
      </div>

      <div className="h-5 w-px bg-surface-border" />

      <div className="flex items-center gap-2 text-[13px] text-ink-muted">
        <span className="sc-dot sc-dot--success" />
        <span>Local session</span>
        <span className="sc-mono text-ink-faint">{elapsed(now - start)}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {onInterview && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('skillcue:toggle-focus'))}
            className="btn-secondary btn-sm"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
            Focus
          </button>
        )}
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          Local · Private
        </span>
      </div>
    </header>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { backendOnline } = useApp();
  const { pathname } = useLocation();
  const wide = WIDE_ROUTES.has(pathname);
  const showTitleBar = !NO_TITLEBAR_ROUTES.has(pathname);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-ink">
      <CommandPalette />
      {showTitleBar && <TitleBar onInterview={pathname === '/interview'} />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!backendOnline && (
            <div className="shrink-0 border-b border-red-900/30 bg-red-950/20 px-5 py-2 text-sm text-red-200/90">
              Backend offline — start API:{' '}
              <code className="rounded-md bg-black/30 px-1.5 py-0.5 text-red-100">
                cd apps/api-py; .\run_dev.ps1
              </code>
            </div>
          )}
          <div
            className={`mx-auto flex min-h-0 w-full flex-1 flex-col ${
              wide ? 'max-w-[1600px] px-5 py-4' : 'max-w-5xl overflow-y-auto px-8 py-8'
            }`}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
