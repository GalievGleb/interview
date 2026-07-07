import { useState } from 'react';
import { isSpeculativeEnabled, setSpeculative } from '../../lib/speculativePref';
import { useI18n } from '../../lib/i18n';

/** Toggle for speculative answering: start the LLM on a stable partial
 *  transcript before the final arrives — shaves ~0.5–1.5s off perceived latency
 *  at the cost of occasional wasted tokens when the partial differs. */
export default function SpeculativeToggle() {
  const { t } = useI18n();
  const [on, setOn] = useState(isSpeculativeEnabled());

  const toggle = () => {
    const next = !on;
    setOn(next);
    setSpeculative(next);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      title={t('answer.speculativeTitle')}
      className={`btn-sm inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        on
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-surface-border text-ink-muted hover:text-ink'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${on ? 'bg-accent' : 'bg-ink-faint'}`} />
      {t('answer.speculative')}
    </button>
  );
}
