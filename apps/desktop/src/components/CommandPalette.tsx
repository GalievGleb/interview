import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getFastAnswer, setFastAnswer } from '../lib/api';
import { answerChimeEnabled, setAnswerChime } from '../lib/notifySound';
import { isSpeculativeEnabled, setSpeculative } from '../lib/speculativePref';

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** App-wide Ctrl/Cmd+K command palette (Linear/Raycast style). */
export default function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: Command[] = useMemo(
    () => [
      { id: 'interview', label: 'Перейти: Interview (live)', hint: 'live', run: () => navigate('/interview') },
      { id: 'meeting', label: 'Перейти: Разбор разговора', run: () => navigate('/meeting') },
      { id: 'documents', label: 'Перейти: Documents', run: () => navigate('/documents') },
      { id: 'history', label: 'Перейти: История', run: () => navigate('/history') },
      { id: 'testlab', label: 'Перейти: Test Lab', run: () => navigate('/test-lab') },
      { id: 'settings', label: 'Перейти: Настройки', run: () => navigate('/settings') },
      { id: 'licenses', label: 'Перейти: Лицензии', run: () => navigate('/licenses') },
      {
        id: 'fast',
        label: `Быстрый ответ: ${getFastAnswer() ? 'выключить' : 'включить'}`,
        run: () => setFastAnswer(!getFastAnswer()),
      },
      {
        id: 'chime',
        label: `Звук «ответ готов»: ${answerChimeEnabled() ? 'выключить' : 'включить'}`,
        run: () => setAnswerChime(!answerChimeEnabled()),
      },
      {
        id: 'speculative',
        label: `Спекулятивный ответ (по partial): ${isSpeculativeEnabled() ? 'выключить' : 'включить'}`,
        run: () => setSpeculative(!isSpeculativeEnabled()),
      },
      { id: 'overlay', label: 'Открыть overlay', hint: 'Ctrl+Shift+H', run: () => void window.electronAPI?.overlay.show() },
    ],
    [navigate],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuery('');
        setActive(0);
        setOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Allow other UI (e.g. the sidebar search row) to open the palette by click.
  useEffect(() => {
    const open = () => {
      setQuery('');
      setActive(0);
      setOpen(true);
    };
    window.addEventListener('skillcue:open-palette', open);
    return () => window.removeEventListener('skillcue:open-palette', open);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const execute = (cmd?: Command) => {
    if (!cmd) return;
    cmd.run();
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/50 pt-[18vh] backdrop-blur-sm"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-surface-border bg-surface-elevated shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              execute(filtered[active]);
            }
          }}
          placeholder="Команда или экран…"
          className="w-full border-b border-surface-border bg-transparent px-4 py-3.5 text-[15px] text-ink outline-none placeholder:text-ink-faint"
        />
        <div className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-ink-faint">Ничего не найдено</p>
          )}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => execute(c)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                i === active ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-surface-hover'
              }`}
            >
              <span>{c.label}</span>
              {c.hint && <span className="cockpit-kbd">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
