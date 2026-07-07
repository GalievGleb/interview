import { useEffect, useRef } from 'react';
import { useI18n } from '../../lib/i18n';

interface ManualQuestionBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  disabled: boolean;
  error?: string;
}

export default function ManualQuestionBox({
  value,
  onChange,
  onSubmit,
  loading,
  disabled,
  error,
}: ManualQuestionBoxProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Ctrl+L — мгновенный фокус на поле: Ctrl+K зарезервирован под палитру команд.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'l' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="border-t border-surface-border bg-surface/20 px-4 py-3">
      <div className="cockpit-command">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit();
          }}
          placeholder={t('manual.placeholder')}
          rows={2}
          className="cockpit-command-input"
        />
        <div className="cockpit-command-bar">
          <span className="text-[11px] text-ink-faint">
            <kbd className="cockpit-kbd !ml-0">Ctrl</kbd>
            <span className="mx-1">+</span>
            <kbd className="cockpit-kbd !ml-0">Enter</kbd>
            <span className="ml-1.5 hidden sm:inline">{t('manual.toSend')}</span>
          </span>
          <button
            type="button"
            onClick={onSubmit}
            disabled={loading || disabled || !value.trim()}
            className="btn-primary btn-sm"
          >
            {loading ? t('manual.composing') : t('manual.getAnswer')}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-red-400/90">{error}</p>}
    </div>
  );
}
