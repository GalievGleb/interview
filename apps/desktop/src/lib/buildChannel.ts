import { useEffect, useState } from 'react';

export type BuildChannel = 'stable' | 'dev' | 'alpha';

function browserFallback(): BuildChannel {
  return import.meta.env.DEV ? 'dev' : 'stable';
}

/**
 * Resolves the signed build channel from Electron. Until it is known, callers
 * must fail closed so developer surfaces never flash in the stable product.
 */
export function useBuildChannel(): BuildChannel | null {
  const [channel, setChannel] = useState<BuildChannel | null>(() => {
    if (typeof window === 'undefined') return 'stable';
    return window.electronAPI?.getBuildChannel ? null : browserFallback();
  });

  useEffect(() => {
    const getBuildChannel = window.electronAPI?.getBuildChannel;
    if (!getBuildChannel) {
      setChannel(browserFallback());
      return;
    }

    let active = true;
    void getBuildChannel()
      .then((next) => {
        if (active) setChannel(next === 'dev' || next === 'alpha' ? next : 'stable');
      })
      .catch(() => {
        if (active) setChannel('stable');
      });
    return () => {
      active = false;
    };
  }, []);

  return channel;
}
