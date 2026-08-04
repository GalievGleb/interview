export type DesktopUpdaterStatus = {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'waiting-for-session-end'
    | 'installing'
    | 'none'
    | 'error';
  version?: string;
  percent?: number;
  message?: string;
};

export function createUpdaterStatusStore(
  notify: (status: DesktopUpdaterStatus) => void,
) {
  let current: DesktopUpdaterStatus = { state: 'idle' };

  return {
    get(): DesktopUpdaterStatus {
      return { ...current };
    },
    publish(next: DesktopUpdaterStatus): void {
      current = { ...next };
      notify({ ...current });
    },
  };
}
