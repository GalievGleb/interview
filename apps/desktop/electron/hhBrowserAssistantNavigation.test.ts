import { describe, expect, it } from 'vitest';
import {
  browserLaunchArguments,
  isBrokenHhLoginSourcePage,
  isRecoverableHhLoginNavigationAbort,
} from './hhBrowserAssistant';

describe('HH login navigation recovery', () => {
  it('launches background automation headlessly without an extra blank target', () => {
    const args = browserLaunchArguments('C:\\tmp\\skillcue-browser', 43210, 'background');
    expect(args).toContain('--headless=new');
    expect(args).not.toContain('--start-maximized');
    expect(args).not.toContain('about:blank');
  });

  it('only exposes Chrome for an explicit interactive action', () => {
    const args = browserLaunchArguments('C:\\tmp\\skillcue-browser', 43210, 'interactive');
    expect(args).toContain('--start-maximized');
    expect(args).not.toContain('--headless=new');
    expect(args).not.toContain('about:blank');
  });

  it('accepts ERR_ABORTED when the expected HH login page is already open', () => {
    expect(
      isRecoverableHhLoginNavigationAbort(
        new Error('page.goto: net::ERR_ABORTED'),
        'https://hh.ru/account/login?backurl=%2Fapplicant%2Fresumes&role=applicant',
      ),
    ).toBe(true);
  });

  it('does not hide unrelated navigation failures or pages', () => {
    expect(
      isRecoverableHhLoginNavigationAbort(
        new Error('page.goto: net::ERR_FAILED'),
        'https://hh.ru/account/login',
      ),
    ).toBe(false);
    expect(
      isRecoverableHhLoginNavigationAbort(
        new Error('page.goto: net::ERR_ABORTED'),
        'https://hh.ru/vacancy/123',
      ),
    ).toBe(false);
    expect(
      isRecoverableHhLoginNavigationAbort(
        new Error('page.goto: net::ERR_ABORTED'),
        'https://example.com/account/login',
      ),
    ).toBe(false);
  });

  it('recognizes the restored HH routes that must not be reused for login', () => {
    expect(isBrokenHhLoginSourcePage('https://hh.ru/negotiations')).toBe(true);
    expect(isBrokenHhLoginSourcePage('https://hh.ru/404')).toBe(true);
    expect(isBrokenHhLoginSourcePage('https://hh.ru/account/login')).toBe(false);
    expect(isBrokenHhLoginSourcePage('https://example.com/negotiations')).toBe(false);
  });
});
