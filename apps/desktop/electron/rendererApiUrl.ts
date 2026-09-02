import { getAppIdentity, type BuildChannel } from './buildChannel';

function rendererBuildChannel(mode: string): BuildChannel {
  if (mode === 'alphabuild') return 'alpha';
  return mode === 'development' || mode === 'devbuild' ? 'dev' : 'stable';
}

/**
 * Keep the renderer API origin aligned with the Electron build identity.
 *
 * Stable and developer builds deliberately use different ports so they can run
 * side by side. Vite cannot read Electron's runtime constant, therefore the
 * matching origin is injected while the renderer bundle is built.
 */
export function resolveRendererApiUrl(mode: string, override?: string): string {
  const configured = override?.trim();
  if (configured) return configured.replace(/\/$/u, '');

  const identity = getAppIdentity(rendererBuildChannel(mode));
  return `http://127.0.0.1:${identity.apiPort}`;
}
