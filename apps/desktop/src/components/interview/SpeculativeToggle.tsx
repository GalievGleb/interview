import { useState } from 'react';
import { isSpeculativeEnabled, setSpeculative } from '../../lib/speculativePref';

/** Toggle for speculative answering: start the LLM on a stable partial
 *  transcript before the final arrives — shaves ~0.5–1.5s off perceived latency
 *  at the cost of occasional wasted tokens when the partial differs. */
export default function SpeculativeToggle() {
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
      title="Опережающий ответ: начать генерацию по стабильному промежуточному транскрипту, не дожидаясь финального. Быстрее на ~1с, но может тратить токены впустую, если фраза изменится"
      className={`btn-sm inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        on
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-surface-border text-ink-muted hover:text-ink'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${on ? 'bg-accent' : 'bg-ink-faint'}`} />
      Опережающий ответ
    </button>
  );
}
