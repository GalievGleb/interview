export interface TaskbarWindow {
  setSkipTaskbar(skip: boolean): void;
}

export interface MacDock {
  hide(): void;
  show(): void;
}

export function setAppHiddenFromSwitcher(
  platform: NodeJS.Platform,
  hidden: boolean,
  window: TaskbarWindow | null | undefined,
  dock: MacDock | null | undefined,
): void {
  if (platform === 'darwin' && dock) {
    if (hidden) dock.hide();
    else dock.show();
    return;
  }
  window?.setSkipTaskbar(hidden);
}
