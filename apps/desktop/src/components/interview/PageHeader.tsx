import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle: string;
  action?: ReactNode;
}

export default function PageHeader({ title, subtitle, action }: PageHeaderProps) {
  return (
    <header className="cockpit-header">
      <div className="min-w-0">
        <h1 className="cockpit-header-title">{title}</h1>
        <p className="cockpit-header-sub">{subtitle}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}
