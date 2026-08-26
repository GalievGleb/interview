import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browserLaunchArguments,
  debugInfoFromBrowserCommandLine,
  isAlreadyAppliedHhText,
  isBrokenHhLoginSourcePage,
  isRecoverableHhLoginNavigationAbort,
  normalizePersistedQueue,
  profileBrowserCommandLineScript,
} from './hhBrowserAssistant';

describe('HH login navigation recovery', () => {
  it('keeps résumé title facts and closes chat before opening a vacancy', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'hhBrowserAssistant.ts'), 'utf8');
    expect(source).toContain("[preferred.title, result.text].filter(Boolean).join('\\n')");
    const openVacancy = source.slice(source.indexOf('async openVacancy('), source.indexOf('async fillCoverLetter('));
    expect(openVacancy).toContain('await this.chatPage.close()');
    expect(openVacancy.indexOf('await this.chatPage.close()')).toBeLessThan(openVacancy.indexOf("ensureBrowser('interactive')"));
    expect(openVacancy).toContain("vacancy.status === 'already_applied'");
  });

  it('does not bring an inaccessible vacancy page to the user for manual confirmation', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'hhBrowserAssistant.ts'), 'utf8');
    const openVacancy = source.slice(source.indexOf('async openVacancy('), source.indexOf('async fillCoverLetter('));
    expect(openVacancy).toContain('isUnavailableHhVacancyText');
    expect(openVacancy.indexOf('isUnavailableHhVacancyText')).toBeLessThan(
      openVacancy.indexOf('await page.bringToFront()'),
    );
    expect(openVacancy).toContain("status: 'skipped'");
    expect(openVacancy).toContain('Вакансия больше недоступна на HH.');
  });

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

  it('recovers the CDP endpoint from a surviving private-profile browser', () => {
    expect(debugInfoFromBrowserCommandLine(
      'chrome.exe --headless=new --remote-debugging-port=54364 --user-data-dir="C:\\SkillCue"',
    )).toEqual({ port: 54364, mode: 'background' });
    expect(debugInfoFromBrowserCommandLine(
      'msedge.exe --remote-debugging-port 43110 --start-maximized',
    )).toEqual({ port: 43110, mode: 'interactive' });
    expect(debugInfoFromBrowserCommandLine('chrome.exe --start-maximized')).toBeNull();
  });

  it('builds a valid single-statement PowerShell profile lookup', () => {
    const script = profileBrowserCommandLineScript();
    expect(script).not.toContain('{;');
    expect(script).not.toContain('-and;');
    expect(script).toContain("--remote-debugging-port(?:=|\\s+)(\\d+)");
  });

  it('prefers the live browser port over a stale persisted port before launching again', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'hhBrowserAssistant.ts'), 'utf8');
    const launchAt = source.indexOf('private async launchInstalledBrowser');
    const launchSource = source.slice(launchAt, source.indexOf('private async closeExcessAutomationPages', launchAt));
    expect(launchSource).toContain('const runningBrowser = await runningProfileDebugInfo(this.profileDir)');
    expect(launchSource).toContain('const activeBrowsers = [runningBrowser, persistedBrowser]');
    expect(launchSource.indexOf('for (const activeBrowser of activeBrowsers)')).toBeLessThan(
      launchSource.indexOf('await terminateOrphanedProfileBrowsers(this.profileDir)'),
    );
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

  it('recognizes current and legacy HH already-applied messages', () => {
    expect(isAlreadyAppliedHhText('Вы откликнулись')).toBe(true);
    expect(isAlreadyAppliedHhText('Вы уже откликнулись на эту вакансию')).toBe(true);
    expect(isAlreadyAppliedHhText('Отклик был отправлен ранее')).toBe(true);
    expect(isAlreadyAppliedHhText('Отклик другим резюме')).toBe(false);
    expect(isAlreadyAppliedHhText('Откликнуться')).toBe(false);
  });

  it('restores an accepted response with a missing cover letter to the actionable queue', () => {
    const [vacancy] = normalizePersistedQueue([{
      id: '135717978',
      key: 'hh:135717978',
      platform: 'hh',
      title: 'Automation QA (Python)',
      company: 'BLACKHUB GAMES',
      url: 'https://hh.ru/vacancy/135717978',
      status: 'already_applied',
      addedAt: '2026-08-09T11:12:00.000Z',
      coverLetterPending: true,
      coverLetterAdded: false,
    }]);

    expect(vacancy).toMatchObject({
      id: '135717978',
      status: 'opened',
      coverLetterPending: true,
      coverLetterAdded: undefined,
    });
  });

  it('repairs a recent response that the old flow marked sent without confirming a letter', () => {
    const [vacancy] = normalizePersistedQueue([{
      id: '136200001',
      platform: 'hh',
      title: 'QA Engineer',
      url: 'https://hh.ru/vacancy/136200001',
      status: 'sent',
      reason: 'Отклик отправлен',
      addedAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      coverLetterAdded: false,
    }]);

    expect(vacancy).toMatchObject({
      status: 'opened',
      coverLetterPending: true,
      coverLetterAdded: undefined,
    });
    expect(vacancy.reason).toContain('без подтверждённого письма');
  });

  it('restores vacancies hidden by the old pre-submission cover-letter marker', () => {
    const [vacancy] = normalizePersistedQueue([{
      id: '136143010',
      key: 'hh:136143010',
      platform: 'hh',
      title: 'Тестировщик-автоматизатор / QA',
      company: 'VisionLabs',
      url: 'https://hh.ru/vacancy/136143010',
      status: 'skipped',
      reason: 'Отклик больше не найден в активных переговорах HH — письмо отправлять некуда.',
      addedAt: '2026-08-11T15:19:32.801Z',
      coverLetterPending: false,
      coverLetterAdded: false,
    }]);

    expect(vacancy).toMatchObject({
      id: '136143010',
      status: 'new',
      coverLetterPending: undefined,
      coverLetterAdded: undefined,
    });
    expect(vacancy.reason).toContain('возвращена в очередь');
  });

  it('repairs the false missing-negotiation skip regardless of stored schema version', () => {
    const [vacancy] = normalizePersistedQueue([{
      id: '136143010',
      platform: 'hh',
      title: 'Тестировщик-автоматизатор / QA',
      url: 'https://hh.ru/vacancy/136143010',
      status: 'skipped',
      reason: 'Отклик больше не найден в активных переговорах HH — письмо отправлять некуда.',
      addedAt: '2026-08-11T15:19:32.801Z',
    }], false);

    expect(vacancy).toMatchObject({
      status: 'new',
      coverLetterPending: undefined,
    });
    expect(vacancy.reason).toContain('возвращена в очередь');
  });

  it('keeps the missing-negotiation result terminal only after a confirmed send', () => {
    const [vacancy] = normalizePersistedQueue([{
      id: '136064787',
      platform: 'hh',
      title: 'Senior Auto QA-инженер Python',
      url: 'https://hh.ru/vacancy/136064787',
      status: 'skipped',
      reason: 'Отклик больше не найден в активных переговорах HH — письмо отправлять некуда.',
      addedAt: '2026-08-11T15:19:32.801Z',
      sentAt: '2026-08-11T15:20:32.801Z',
    }]);

    expect(vacancy).toMatchObject({
      status: 'skipped',
      sentAt: '2026-08-11T15:20:32.801Z',
    });
  });

  it('restores vacancies skipped only because remote work was not stated explicitly', () => {
    const [vacancy] = normalizePersistedQueue([{
      id: '136064787',
      platform: 'hh',
      title: 'Senior Auto QA-инженер Python',
      company: 'ООО Live Typing',
      url: 'https://hh.ru/vacancy/136064787',
      status: 'skipped',
      reason: 'Пропущено перед откликом: в вакансии не подтверждён выбранный удалённый формат работы.',
      addedAt: '2026-08-11T15:19:32.801Z',
    }]);

    expect(vacancy).toMatchObject({
      status: 'new',
      coverLetterPending: undefined,
    });
    expect(vacancy.reason).toContain('не был опровергнут');
  });

  it('keeps an explicitly skipped vacancy skipped even if an old letter marker remains', () => {
    const [vacancy] = normalizePersistedQueue([{
      id: '136143972',
      key: 'hh:136143972',
      platform: 'hh',
      title: 'QA специалист (офис в Москве)',
      company: 'Example',
      url: 'https://hh.ru/vacancy/136143972',
      status: 'skipped',
      reason: 'Пропущено пользователем',
      addedAt: '2026-08-11T17:30:00.000Z',
      coverLetterPending: true,
      coverLetterAdded: false,
    }]);

    expect(vacancy).toMatchObject({
      status: 'skipped',
      coverLetterPending: undefined,
      coverLetterAdded: undefined,
    });
  });

  it('keeps an unanswered employer question ahead of a stale letter marker', () => {
    const [vacancy] = normalizePersistedQueue([{
      id: '136089306',
      platform: 'hh',
      title: 'QA Automation Engineer',
      url: 'https://hh.ru/vacancy/136089306',
      status: 'opened',
      addedAt: '2026-08-11T17:30:00.000Z',
      coverLetterPending: true,
      pendingQuestions: [{
        id: 'contract',
        prompt: 'Подходит ли срочный договор?',
        kind: 'single',
        options: ['Да', 'Нет'],
        required: true,
      }],
    }]);

    expect(vacancy).toMatchObject({
      status: 'needs_input',
      coverLetterPending: undefined,
      pendingQuestions: [{ id: 'contract' }],
    });
  });
});
