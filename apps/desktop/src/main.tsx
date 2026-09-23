import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initTheme } from './lib/theme';
import { installGlobalErrorCapture } from './lib/errorLog';
import { applyRuntimePlatform } from './lib/runtimePlatform';
import './index.css';

applyRuntimePlatform(document.documentElement, window.electronAPI?.platform);
initTheme();
installGlobalErrorCapture();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>,
);
