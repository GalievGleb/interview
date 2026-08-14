import { describe, expect, it } from 'vitest';
import {
  browserCandidatePaths,
  browserLaunchFailureMessage,
  profileBrowserCleanupScript,
  profileBrowserCommandLineScript,
} from './hhBrowserAssistant';

describe('Windows browser discovery for HH automation', () => {
  it('discovers stable Chromium browsers in per-user and machine-wide locations', () => {
    const candidates = browserCandidatePaths('win32', {
      LocalAppData: 'C:\\Users\\tester\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    });

    expect(candidates).toEqual(expect.arrayContaining([
      {
        label: 'Google Chrome',
        executable: 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      },
      {
        label: 'Microsoft Edge',
        executable: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      },
      {
        label: 'Brave',
        executable: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      },
      {
        label: 'Vivaldi',
        executable: 'C:\\Users\\tester\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe',
      },
      {
        label: 'Chromium',
        executable: 'C:\\Users\\tester\\AppData\\Local\\Chromium\\Application\\chrome.exe',
      },
    ]));
  });

  it('prefers an explicit portable Chrome path and accepts case-insensitive Windows env names', () => {
    const candidates = browserCandidatePaths('win32', {
      chrome_path: 'D:\\Portable\\Chrome\\chrome.exe',
      localappdata: 'C:\\Users\\tester\\AppData\\Local',
      programw6432: 'C:\\Program Files',
    });

    expect(candidates[0]).toEqual({
      label: 'Google Chrome',
      executable: 'D:\\Portable\\Chrome\\chrome.exe',
    });
    expect(candidates).toContainEqual({
      label: 'Microsoft Edge',
      executable: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    });
  });

  it('explains why an installed Firefox cannot be used as the HH automation browser', () => {
    const message = browserLaunchFailureMessage(0, []);

    expect(message).toContain('Chrome, Edge, Brave, Vivaldi или Chromium');
    expect(message).toContain('Firefox не подходит');
  });

  it('preserves launch diagnostics when a discovered browser fails to start', () => {
    expect(browserLaunchFailureMessage(1, [
      'Google Chrome: процесс завершился с кодом 21',
    ])).toContain('Google Chrome: процесс завершился с кодом 21');
  });

  it('reconnects to and cleans up every supported Windows browser process', () => {
    for (const script of [profileBrowserCommandLineScript(), profileBrowserCleanupScript()]) {
      expect(script).toContain("$_.Name -eq 'chrome.exe'");
      expect(script).toContain("$_.Name -eq 'msedge.exe'");
      expect(script).toContain("$_.Name -eq 'brave.exe'");
      expect(script).toContain("$_.Name -eq 'vivaldi.exe'");
    }
  });
});
