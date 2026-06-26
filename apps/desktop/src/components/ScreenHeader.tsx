import type { ReactNode } from 'react';

/** Shared page-header strip for every non-live screen (redesign pattern). */
export default function ScreenHeader({
  title,
  subtitle,
  badge,
  actions,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-surface-border pb-[18px]">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="text-[20px] font-semibold tracking-[-0.014em] text-ink">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
