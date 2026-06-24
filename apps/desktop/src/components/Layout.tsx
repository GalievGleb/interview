import { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useApp } from '../context/AppContext';

const WIDE_ROUTES = new Set(['/interview', '/meeting']);

export default function Layout({ children }: { children: ReactNode }) {
  const { backendOnline } = useApp();
  const { pathname } = useLocation();
  const wide = WIDE_ROUTES.has(pathname);

  return (
    <div className="flex h-screen overflow-hidden bg-surface text-ink">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!backendOnline && (
          <div className="shrink-0 border-b border-red-900/30 bg-red-950/20 px-5 py-2 text-sm text-red-200/90">
            Backend offline — start API:{' '}
            <code className="rounded-md bg-black/30 px-1.5 py-0.5 text-red-100">
              cd apps/api-py; .\run_dev.ps1
            </code>
          </div>
        )}
        <div
          className={`mx-auto flex min-h-0 w-full flex-1 flex-col ${
            wide ? 'max-w-[1600px] px-5 py-4' : 'max-w-5xl overflow-y-auto px-8 py-8'
          }`}
        >
          {children}
        </div>
      </main>
    </div>
  );
}
