import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HhBrowserAssistant,
  type HhAssistantState,
  type HhQueueItem,
} from './hhBrowserAssistant';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HH account logout', () => {
  it('marks HH as the active platform when an existing HH cookie answers the login-code request', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-existing-cookie-'));
    directories.push(userDataDir);
    const assistant = new HhBrowserAssistant(userDataDir, () => undefined);
    const internal = assistant as unknown as {
      state: HhAssistantState;
      openFreshHhLoginPage: () => Promise<{ url: () => string }>;
      hasHhAuthCookie: () => Promise<boolean>;
    };
    internal.state = {
      ...internal.state,
      browserOpen: true,
      loginRequired: false,
      config: {
        ...internal.state.config,
        platform: 'linkedin',
        query: 'QA Automation Engineer',
      },
    };
    internal.openFreshHhLoginPage = async () => ({ url: () => 'https://hh.ru/applicant/resumes' });
    internal.hasHhAuthCookie = async () => true;

    const result = await assistant.requestLoginCode('student@example.com');

    expect(result).toEqual({ ok: true, message: 'HH уже подключён.' });
    expect(assistant.getState()).toMatchObject({
      browserOpen: true,
      loginRequired: false,
      config: {
        platform: 'hh',
        query: 'QA Automation Engineer',
      },
    });
  });

  it('clears the HH browser session and pauses retained work before another account signs in', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-logout-'));
    directories.push(userDataDir);
    const assistant = new HhBrowserAssistant(userDataDir, () => undefined);
    const now = new Date().toISOString();
    const retainedQueue: HhQueueItem[] = [{
      id: '123',
      key: 'hh:123',
      platform: 'hh',
      title: 'QA Automation Engineer',
      company: 'Example',
      salary: '',
      url: 'https://hh.ru/vacancy/123',
      status: 'new',
      addedAt: now,
    }];
    let cookies = [
      { name: 'crypted_id', value: 'old-account', domain: '.hh.ru', path: '/' },
      { name: 'hhuid', value: 'old-device', domain: 'hh.ru', path: '/' },
      { name: 'li_at', value: 'keep-linkedin', domain: '.linkedin.com', path: '/' },
    ];
    let contextClosed = false;
    const context = {
      cookies: async () => structuredClone(cookies),
      clearCookies: async (filter?: { domain?: string | RegExp }) => {
        const domain = filter?.domain;
        cookies = cookies.filter((cookie) => {
          if (!domain) return false;
          return domain instanceof RegExp ? !domain.test(cookie.domain) : cookie.domain !== domain;
        });
      },
      pages: () => [],
      close: async () => { contextClosed = true; },
    };
    const internal = assistant as unknown as {
      context: typeof context | null;
      browserMode: 'background' | null;
      state: HhAssistantState;
      resetBrowserConnection: () => Promise<void>;
      automationRunInFlight: boolean;
      applyInFlight: boolean;
    };
    internal.context = context;
    internal.browserMode = 'background';
    internal.state = {
      ...internal.state,
      browserOpen: true,
      loginRequired: false,
      applying: true,
      queuePaused: false,
      queue: retainedQueue,
      runHistory: [{
        id: 'run-1',
        platform: 'hh',
        trigger: 'manual',
        status: 'running',
        startedAt: now,
        query: 'QA Automation Engineer',
        found: 1,
        attempted: 0,
        sent: 0,
        alreadyApplied: 0,
        skipped: 0,
        needsAttention: 0,
        message: 'Выполняется',
      }],
      config: {
        ...internal.state.config,
        query: 'QA Automation Engineer',
        resumeTitles: ['QA Automation — old account'],
        resumeTitleContains: 'old account',
        autoRunDaily: true,
      },
    };
    internal.automationRunInFlight = true;
    internal.applyInFlight = true;
    // Browser process teardown is an OS boundary. Keep cookie/state behavior real,
    // and replace only the slow process-tree cleanup in this unit test.
    internal.resetBrowserConnection = async () => {
      await context.close();
      internal.context = null;
      internal.browserMode = null;
    };

    const state = await assistant.logout();

    expect(cookies).toEqual([
      { name: 'li_at', value: 'keep-linkedin', domain: '.linkedin.com', path: '/' },
    ]);
    expect(contextClosed).toBe(true);
    expect(state).toMatchObject({
      phase: 'idle',
      browserOpen: false,
      loginRequired: true,
      applying: false,
      stopRequested: false,
      queuePaused: true,
      config: {
        query: 'QA Automation Engineer',
        resumeTitles: [],
        resumeTitleContains: '',
        autoRunDaily: false,
      },
      queue: retainedQueue,
    });
    expect(state.runHistory[0]).toMatchObject({
      id: 'run-1',
      status: 'stopped',
      message: 'Остановлен при выходе из аккаунта HH.',
    });
    expect(state.runHistory[0]?.finishedAt).toEqual(expect.any(String));
  });
});
