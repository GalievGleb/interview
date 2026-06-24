import type { ReactNode } from 'react';

export type AnswerTab = 'short' | 'spoken' | 'detailed' | 'english' | 'risk';

export const ANSWER_TABS: { key: AnswerTab; label: string }[] = [
  { key: 'short', label: 'Short' },
  { key: 'spoken', label: 'Say aloud' },
  { key: 'detailed', label: 'Detailed' },
  { key: 'english', label: 'English' },
  { key: 'risk', label: 'Risks' },
];

interface AnswerTabsProps {
  tab: AnswerTab;
  onTabChange: (tab: AnswerTab) => void;
  trailing?: ReactNode;
}

export default function AnswerTabs({ tab, onTabChange, trailing }: AnswerTabsProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-4 py-3">
      <div className="cockpit-tabs-list" role="tablist">
        {ANSWER_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => onTabChange(t.key)}
            className={`cockpit-tab ${tab === t.key ? 'cockpit-tab-active' : ''}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {trailing && <div className="flex items-center gap-2 text-xs text-ink-faint">{trailing}</div>}
    </div>
  );
}
