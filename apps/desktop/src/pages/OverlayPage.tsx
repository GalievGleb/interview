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
    <div className="flex h-screen flex-col bg-transparent p-3 text-ink">
      <div className="mb-2 flex items-center justify-between rounded-xl border border-white/10 bg-black/80 px-3 py-2 backdrop-blur-md">
        <span className="overlay-drag flex-1 text-xs text-ink-muted">Copilot · Overlay</span>
        <button
          type="button"
          onClick={() => void window.electronAPI?.overlay.hide()}
          className="overlay-no-drag rounded-lg bg-white/10 px-3 py-1 text-xs transition-colors hover:bg-white/20"
        >
          Скрыть
        </button>
      </div>
      <div className="overlay-no-drag min-h-0 flex-1 rounded-xl border border-white/10 bg-black/80 p-3 backdrop-blur-md">
        <LiveCopilot compact />
      </div>
    </div>
  );
}
