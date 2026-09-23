export type RuntimePlatform = 'darwin' | 'win32' | 'linux';

interface PlatformRoot {
  dataset: Record<string, string | undefined>;
}

export function applyRuntimePlatform(
  root: PlatformRoot,
  platform: RuntimePlatform | undefined,
): void {
  if (platform) {
    root.dataset.platform = platform;
    return;
  }
  delete root.dataset.platform;
}
