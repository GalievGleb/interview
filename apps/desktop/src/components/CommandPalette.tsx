import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getFastAnswer, setFastAnswer } from '../lib/api';
import { answerChimeEnabled, setAnswerChime } from '../lib/notifySound';
import { isSpeculativeEnabled, setSpeculative } from '../lib/speculativePref';
import { getLang, setLang, useI18n } from '../lib/i18n';

interface Command {
  id: string;
  label: string;
  hint?: string;
  /** Инструменты разработчика — скрыты из общего списка, ищутся по «dev». */
  dev?: boolean;
  run: () => void;
}

/** App-wide Ctrl/Cmd+K command palette (Linear/Raycast style). */
export default function CommandPalette() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: Command[] = useMemo(
    () => {
      const onOff = (enabled: boolean) => (enabled ? t('cmd.off') : t('cmd.on'));
      return [
        { id: 'home', label: t('cmd.home'), run: () => navigate('/home') },
        { id: 'prepare', label: t('cmd.prepare'), run: () => navigate('/prepare') },
        { id: 'interview', label: t('cmd.interview'), run: () => navigate('/interview') },
        { id: 'documents', label: t('cmd.documents'), run: () => navigate('/documents') },
        { id: 'history', label: t('cmd.history'), run: () => navigate('/history') },
        { id: 'settings', label: t('cmd.settings'), run: () => navigate('/settings') },
        {
          id: 'fast',
          label: `${t('cmd.fast')}: ${onOff(getFastAnswer())}`,
          run: () => setFastAnswer(!getFastAnswer()),
        },
        {
          id: 'chime',
          label: `${t('cmd.chime')}: ${onOff(answerChimeEnabled())}`,
          run: () => setAnswerChime(!answerChimeEnabled()),
        },
        {
          id: 'speculative',
          label: `${t('cmd.speculative')}: ${onOff(isSpeculativeEnabled())}`,
          run: () => setSpeculative(!isSpeculativeEnabled()),
        },
        {
          id: 'lang',
          label: `${t('cmd.lang')}: ${getLang() === 'ru' ? 'English' : 'Русский'}`,
          run: () => setLang(getLang() === 'ru' ? 'en' : 'ru'),
        },
        { id: 'overlay', label: t('cmd.overlay'), hint: 'Ctrl+Shift+H', run: () => void window.electronAPI?.overlay.show() },
        { id: 'meeting', label: t('cmd.meeting'), dev: true, run: () => navigate('/meeting') },
        { id: 'testlab', label: t('cmd.testlab'), dev: true, run: () => navigate('/test-lab') },
        { id: 'benchmark', label: t('cmd.benchmark'), dev: true, run: () => navigate('/benchmark') },
        { id: 'diagnostics', label: t('cmd.diagnostics'), dev: true, run: () => navigate('/diagnostics') },
        { id: 'licenses', label: t('cmd.licenses'), dev: true, run: () => navigate('/licenses') },
      ];
    },
    [navigate, t],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Dev-инструменты не засоряют общий список — появляются, когда пользователь
    // явно набирает «dev».
    const base = q.startsWith('dev') ? commands : commands.filter((c) => !c.dev);
    return q ? base.filter((c) => c.label.toLowerCase().includes(q)) : base;
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
          placeholder={t('cmd.placeholder')}
          className="w-full border-b border-surface-border bg-transparent px-4 py-3.5 text-[15px] text-ink outline-none placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-accent-ring"
        />
        <div className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-ink-faint">{t('cmd.empty')}</p>
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
