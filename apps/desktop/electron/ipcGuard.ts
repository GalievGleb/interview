import type { IpcMainInvokeEvent } from 'electron';

const DEV_ORIGIN = 'http://localhost:5173';

/** Reject IPC calls originating outside the app's own renderer. */
export function assertTrustedSender(event: Pick<IpcMainInvokeEvent, 'senderFrame'>): void {
  const url = event.senderFrame?.url ?? '';
  if (url === DEV_ORIGIN || url.startsWith('file://')) return;
  throw new Error(`Untrusted IPC sender: ${url || '<unknown>'}`);
}
