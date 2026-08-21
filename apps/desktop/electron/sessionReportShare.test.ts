import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { shareSessionReport, telegramDesktopCandidates } from './sessionReportShare';

describe('sessionReportShare', () => {
  it('writes a safe Markdown filename and opens Telegram Desktop with -sendpath', async () => {
    const writeFile = vi.fn();
    const launch = vi.fn();
    const reveal = vi.fn();
    const openExternal = vi.fn();
    const telegram = 'C:\\Users\\student\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe';

    const result = await shareSessionReport(
      { filename: '..\\unsafe report.md', content: '# report' },
      {
        platform: 'win32',
        reportsDir: 'C:\\Users\\student\\Documents\\SkillCue Reports',
        env: { APPDATA: 'C:\\Users\\student\\AppData\\Roaming' },
        exists: (candidate) => candidate === telegram,
        mkdir: vi.fn(),
        writeFile,
        launch,
        reveal,
        openExternal,
      },
    );

    const expected = path.win32.join(
      'C:\\Users\\student\\Documents\\SkillCue Reports',
      'unsafe-report.md',
    );
    expect(writeFile).toHaveBeenCalledWith(expected, '# report');
    expect(launch).toHaveBeenCalledWith(telegram, ['-sendpath', expected]);
    expect(result).toEqual({ path: expected, telegramOpened: true, fallback: false });
    expect(reveal).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('keeps the report reachable and opens support when Telegram Desktop is unavailable', async () => {
    const reveal = vi.fn();
    const openExternal = vi.fn();
    const result = await shareSessionReport(
      { filename: 'report.md', content: '# report' },
      {
        platform: 'win32',
        reportsDir: 'C:\\Reports',
        env: {},
        exists: () => false,
        mkdir: vi.fn(),
        writeFile: vi.fn(),
        launch: vi.fn(),
        reveal,
        openExternal,
      },
    );

    expect(result.telegramOpened).toBe(false);
    expect(result.fallback).toBe(true);
    expect(reveal).toHaveBeenCalledWith(result.path);
    expect(openExternal).toHaveBeenCalledWith('https://t.me/SkillCue');
  });

  it('discovers both roaming and local Telegram Desktop installs without a shell command', () => {
    expect(telegramDesktopCandidates({
      APPDATA: 'C:\\Users\\student\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\student\\AppData\\Local',
    })).toEqual([
      'C:\\Users\\student\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe',
      'C:\\Users\\student\\AppData\\Local\\Telegram Desktop\\Telegram.exe',
      'C:\\Users\\student\\AppData\\Local\\Programs\\Telegram Desktop\\Telegram.exe',
    ]);
  });
});
