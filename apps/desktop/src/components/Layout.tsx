import { ReactNode } from 'react';
import Sidebar from './Sidebar';
import { useApp } from '../context/AppContext';

export default function Layout({ children }: { children: ReactNode }) {
  const { backendOnline } = useApp();

  return (
    <div className="flex h-screen bg-surface text-ink">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {!backendOnline && (
          <div className="border-b border-red-900/40 bg-red-950/30 px-6 py-2.5 text-sm text-red-200">
            Backend не запущен. Запустите API:{' '}
            <code className="rounded-md bg-black/40 px-1.5 py-0.5 text-red-100">
              cd apps/api-py; .\run_dev.ps1
            </code>
          </div>
        )}
        <div className="mx-auto max-w-5xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
