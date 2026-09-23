import type { ReactNode } from 'react';
import Layout from './Layout';

/**
 * Keep the native-looking shell interactive while local services warm up.
 * Individual pages already expose their own loading/disabled states.
 */
export default function StartupGate({ children }: { children: ReactNode }) {
  return <Layout>{children}</Layout>;
}
