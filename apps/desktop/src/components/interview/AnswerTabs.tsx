import type { ReactNode } from 'react';
import { useI18n, type I18nKey } from '../../lib/i18n';

export type AnswerTab = 'short' | 'spoken' | 'detailed' | 'english' | 'risk';

export const ANSWER_TABS: { key: AnswerTab; labelKey: I18nKey }[] = [
  { key: 'spoken', labelKey: 'answer.tab.spoken' },
  { key: 'short', labelKey: 'answer.tab.short' },
  { key: 'detailed', labelKey: 'answer.tab.detailed' },
  { key: 'english', labelKey: 'answer.tab.english' },
  { key: 'risk', labelKey: 'answer.tab.risk' },
];

interface AnswerTabsProps {
  tab: AnswerTab;
  onTabChange: (tab: AnswerTab) => void;
  trailing?: ReactNode;
}

export default function AnswerTabs({ tab, onTabChange, trailing }: AnswerTabsProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-4 py-3">
      <div className="cockpit-tabs-list" role="tablist">
        {ANSWER_TABS.map((tabDef) => (
          <button
            key={tabDef.key}
            type="button"
            role="tab"
            aria-selected={tab === tabDef.key}
            onClick={() => onTabChange(tabDef.key)}
            className={`cockpit-tab ${tab === tabDef.key ? 'cockpit-tab-active' : ''}`}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </div>
      {trailing && <div className="flex items-center gap-2 text-xs text-ink-faint">{trailing}</div>}
    </div>
  );
}
