import path from 'node:path';

const SUPPORT_URL = 'https://t.me/SkillCue';
const MAX_REPORT_CHARS = 900_000;

export interface SessionReportShareDeps {
  platform: NodeJS.Platform;
  reportsDir: string;
  env: Record<string, string | undefined>;
  exists: (candidate: string) => boolean;
  mkdir: (directory: string) => void | Promise<void>;
  writeFile: (target: string, content: string) => void | Promise<void>;
  launch: (executable: string, args: string[]) => void | Promise<void>;
  reveal: (target: string) => void | Promise<void>;
  openExternal: (url: string) => void | Promise<void>;
}

export interface SessionReportShareResult {
  path: string;
  telegramOpened: boolean;
  fallback: boolean;
}

export function telegramDesktopCandidates(
  env: Record<string, string | undefined>,
): string[] {
  const candidates = [
    env.APPDATA && path.win32.join(env.APPDATA, 'Telegram Desktop', 'Telegram.exe'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Telegram Desktop', 'Telegram.exe'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Telegram Desktop', 'Telegram.exe'),
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

function safeFilename(value: string): string {
  const basename = value.replace(/\\/g, '/').split('/').pop() ?? 'session-report.md';
  const stem = basename.replace(/\.md$/i, '').replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${stem || 'session-report'}.md`;
}

export async function shareSessionReport(
  input: { filename: string; content: string },
  deps: SessionReportShareDeps,
): Promise<SessionReportShareResult> {
  await deps.mkdir(deps.reportsDir);
  const pathApi = deps.platform === 'win32' ? path.win32 : path;
  const target = pathApi.join(deps.reportsDir, safeFilename(input.filename));
  await deps.writeFile(target, input.content.slice(0, MAX_REPORT_CHARS));

  if (deps.platform === 'win32') {
    const telegram = telegramDesktopCandidates(deps.env).find(deps.exists);
    if (telegram) {
      try {
        await deps.launch(telegram, ['-sendpath', target]);
        return { path: target, telegramOpened: true, fallback: false };
      } catch {
        // Keep the saved report and use the visible fallback below.
      }
    }
  }

  await deps.reveal(target);
  await deps.openExternal(SUPPORT_URL);
  return { path: target, telegramOpened: false, fallback: true };
}
