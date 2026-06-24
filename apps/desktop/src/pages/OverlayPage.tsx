import { useEffect } from 'react';
import LiveCopilot from '../components/LiveCopilot';

export default function OverlayPage() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void window.electronAPI?.overlay.hide();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="overlay-drag flex h-screen flex-col bg-[#0d0d0d] text-white select-none">
      {/* Top bar */}
      <div className="overlay-no-drag flex items-center justify-between border-b border-white/10 px-4 py-2 overlay-drag">
        <div className="overlay-no-drag flex items-center gap-3">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-white/10 text-xs font-bold">
            V
          </div>
          <span className="text-sm font-medium text-gray-200">Candidate @ Your Company</span>
        </div>

        <div className="overlay-no-drag flex items-center gap-2">
          <div className="relative">
            <button className="flex items-center gap-1.5 rounded border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10">
              <span className="text-red-400">◉</span> Share Audio
              <span className="ml-0.5 text-gray-400">▾</span>
            </button>
            <span className="absolute -right-1 -top-1 rounded bg-red-600 px-1 py-0.5 text-[9px] font-bold leading-none">
              Required
            </span>
          </div>

          <button
            onClick={() => void window.electronAPI?.overlay.hide()}
            className="rounded border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-medium hover:bg-white/10"
          >
            Exit
          </button>

          <div className="mx-1 h-4 w-px bg-white/20" />

          <button className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">⏸</button>
          <button className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">💬</button>
          <button className="rounded p-1.5 text-gray-400 hover:bg-white/10 hover:text-white">⚙</button>
        </div>
      </div>

      {/* Content */}
      <div className="overlay-no-drag min-h-0 flex-1">
        <LiveCopilot compact />
      </div>
    </div>
  );
}
