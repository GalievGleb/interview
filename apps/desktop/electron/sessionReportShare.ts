import path from 'node:path';

const SUPPORT_URL = 'https://t.me/SkillCue';
const MAX_REPORT_CHARS = 900_000;
const MAX_DRAFT_CHARS = 2_000;

export interface SessionReportShareDeps {
  reportsDir: string;
  mkdir: (directory: string) => void | Promise<void>;
  writeFile: (target: string, content: string) => void | Promise<void>;
  reveal: (target: string) => void | Promise<void>;
  openPath: (target: string) => string | Promise<string>;
  openExternal: (url: string) => void | Promise<void>;
}

export interface SessionReportShareResult {
  path: string;
  telegramOpened: boolean;
  fileOpened?: boolean;
  fallback: boolean;
}

function safeFilename(value: string): string {
  const basename = value.replace(/\\/g, '/').split('/').pop() ?? 'session-report.md';
  const stem = basename.replace(/\.md$/i, '').replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${stem || 'session-report'}.md`;
}

export function skillCueSupportUrl(message = '', webFallback = false): string {
  const issue = message.trim().slice(0, MAX_DRAFT_CHARS);
  const draft = [
    'Здравствуйте! Отправляю отчёт SkillCue по проблеме с интервью.',
    issue,
    'Файл отчёта подготовлен — прикрепляю его к сообщению.',
  ].filter(Boolean).join('\n\n');
  const encoded = encodeURIComponent(draft);
  return webFallback
    ? `${SUPPORT_URL}?text=${encoded}`
    : `tg://resolve?domain=SkillCue&text=${encoded}`;
}

export async function shareSessionReport(
  input: { filename: string; content: string; message?: string; action?: 'telegram' | 'open' },
  deps: SessionReportShareDeps,
): Promise<SessionReportShareResult> {
  await deps.mkdir(deps.reportsDir);
  const pathApi = process.platform === 'win32' ? path.win32 : path;
  const target = pathApi.join(deps.reportsDir, safeFilename(input.filename));
  await deps.writeFile(target, input.content.slice(0, MAX_REPORT_CHARS));

  if (input.action === 'open') {
    try {
      const openError = await deps.openPath(target);
      if (!openError) {
        return { path: target, telegramOpened: false, fileOpened: true, fallback: false };
      }
    } catch {
      // Если для Markdown не назначено приложение, файл всё равно остаётся доступен.
    }
    await deps.reveal(target);
    return { path: target, telegramOpened: false, fileOpened: false, fallback: true };
  }

  await deps.reveal(target);
  try {
    await deps.openExternal(skillCueSupportUrl(input.message));
    return { path: target, telegramOpened: true, fallback: false };
  } catch {
    try {
      await deps.openExternal(skillCueSupportUrl(input.message, true));
      return { path: target, telegramOpened: true, fallback: false };
    } catch {
      return { path: target, telegramOpened: false, fallback: true };
    }
  }
}
