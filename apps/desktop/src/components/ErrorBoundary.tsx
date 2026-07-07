import { Component, type ErrorInfo, type ReactNode } from 'react';
import { recordError } from '../lib/errorLog';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches render-time crashes so a single bad screen never white-screens the app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render crash:', error, info.componentStack);
    // В локальный журнал — попадёт в отчёт «Сообщить о проблеме», если пользователь его соберёт.
    recordError('render', error.message, `${error.stack ?? ''}\n${info.componentStack ?? ''}`);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface px-8 text-center text-ink">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/15 text-red-400">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
        </div>
        <div>
          <h1 className="text-lg font-semibold">Что-то пошло не так</h1>
          <p className="mt-1 max-w-md text-sm text-ink-muted">
            Экран упал с ошибкой. Перезагрузите приложение — данные хранятся локально и не потеряны.
          </p>
        </div>
        <pre className="sc-mono max-h-32 max-w-lg overflow-auto rounded-lg border border-surface-border bg-surface-card p-3 text-left text-xs text-ink-faint">
          {error.message}
        </pre>
        <button type="button" onClick={() => window.location.reload()} className="btn-primary">
          Перезагрузить
        </button>
      </div>
    );
  }
}
