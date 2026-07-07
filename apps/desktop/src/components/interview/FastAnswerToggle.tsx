import { useState } from 'react';
import { getFastAnswer, setFastAnswer } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

/** Toggle for fast-answer mode: skips the serial LLM correction pass and asks
 *  the provider to route for throughput — lowest time-to-first-token. */
export default function FastAnswerToggle() {
  const { t } = useI18n();
  const [on, setOn] = useState(getFastAnswer());

  const toggle = () => {
    const next = !on;
    setOn(next);
    setFastAnswer(next);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      title={t('answer.fastTitle')}
      className={`btn-sm inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        on
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-surface-border text-ink-muted hover:text-ink'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${on ? 'bg-accent' : 'bg-ink-faint'}`} />
      {t('answer.fast')}
    </button>
  );
}
