import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { shareSessionReport } from './sessionReportShare';

describe('sessionReportShare', () => {
  it('writes a safe Markdown filename and opens the SkillCue support chat with a prepared message', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const writeFile = vi.fn();
    const launch = vi.fn();
    const reveal = vi.fn();
    const openPath = vi.fn().mockResolvedValue('');
    const openExternal = vi.fn();
    try {
      const result = await shareSessionReport(
        { filename: '..\\unsafe report.md', content: '# report', message: 'Оверлей отвечал пять минут.' },
        {
          reportsDir: 'C:\\Users\\student\\Documents\\SkillCue Reports',
          mkdir: vi.fn(),
          writeFile,
          reveal,
          openPath,
          openExternal,
        },
      );

      const expected = path.win32.join(
        'C:\\Users\\student\\Documents\\SkillCue Reports',
        'unsafe-report.md',
      );
      expect(writeFile).toHaveBeenCalledWith(expected, '# report');
      expect(launch).not.toHaveBeenCalled();
      expect(reveal).toHaveBeenCalledWith(expected);
      expect(openExternal).toHaveBeenCalledWith(
        `tg://resolve?domain=SkillCue&text=${encodeURIComponent('Здравствуйте! Отправляю отчёт SkillCue по проблеме с интервью.\n\nОверлей отвечал пять минут.\n\nФайл отчёта подготовлен — прикрепляю его к сообщению.')}`,
      );
      expect(result).toEqual({ path: expected, telegramOpened: true, fallback: false });
    } finally {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('keeps the report reachable when the Telegram link cannot be opened', async () => {
    const reveal = vi.fn();
    const openPath = vi.fn().mockResolvedValue('');
    const openExternal = vi.fn().mockRejectedValue(new Error('No Telegram handler'));
    const result = await shareSessionReport(
      { filename: 'report.md', content: '# report' },
      {
        reportsDir: 'C:\\Reports',
        mkdir: vi.fn(),
        writeFile: vi.fn(),
        reveal,
        openPath,
        openExternal,
      },
    );

    expect(result.telegramOpened).toBe(false);
    expect(result.fallback).toBe(true);
    expect(reveal).toHaveBeenCalledWith(result.path);
    expect(openExternal).toHaveBeenNthCalledWith(1, expect.stringMatching(/^tg:\/\/resolve\?domain=SkillCue&text=/));
    expect(openExternal).toHaveBeenNthCalledWith(2, expect.stringMatching(/^https:\/\/t\.me\/SkillCue\?text=/));
  });

  it('opens the saved report itself without launching Telegram', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const writeFile = vi.fn();
    const reveal = vi.fn();
    const openPath = vi.fn().mockResolvedValue('');
    const openExternal = vi.fn();
    try {
      const result = await shareSessionReport(
        { filename: 'session.md', content: '# session', action: 'open' },
        {
          reportsDir: 'C:\\Reports',
          mkdir: vi.fn(),
          writeFile,
          reveal,
          openPath,
          openExternal,
        },
      );

      const expected = path.win32.join('C:\\Reports', 'session.md');
      expect(writeFile).toHaveBeenCalledWith(expected, '# session');
      expect(openPath).toHaveBeenCalledWith(expected);
      expect(openExternal).not.toHaveBeenCalled();
      expect(reveal).not.toHaveBeenCalled();
      expect(result).toEqual({
        path: expected,
        telegramOpened: false,
        fileOpened: true,
        fallback: false,
      });
    } finally {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('reveals the saved report when Windows has no app for Markdown files', async () => {
    const reveal = vi.fn();
    const openExternal = vi.fn();
    const result = await shareSessionReport(
      { filename: 'session.md', content: '# session', action: 'open' },
      {
        reportsDir: 'C:\\Reports',
        mkdir: vi.fn(),
        writeFile: vi.fn(),
        reveal,
        openPath: vi.fn().mockResolvedValue('No application is associated with this file'),
        openExternal,
      },
    );

    expect(result.fileOpened).toBe(false);
    expect(result.fallback).toBe(true);
    expect(reveal).toHaveBeenCalledWith(result.path);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
