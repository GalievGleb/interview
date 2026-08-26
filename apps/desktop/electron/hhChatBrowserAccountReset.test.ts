import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HhChatBrowser, type HhChatState } from './hhChatBrowser';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HH chat account reset', () => {
  it('stops polling and removes live data belonging to the signed-out account', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-logout-'));
    directories.push(userDataDir);
    const chat = new HhChatBrowser(
      userDataDir,
      async () => null,
      async () => '',
    );
    const internal = chat as unknown as {
      config: HhChatState['config'];
      conversations: HhChatState['conversations'];
      pendingDecisions: HhChatState['pendingDecisions'];
      confirmedFacts: HhChatState['confirmedFacts'];
      polling: boolean;
      error: string | null;
      activeNegotiations: number;
      checkedNegotiations: number;
      unreadMessages: number;
    };
    internal.config.enabled = true;
    internal.polling = true;
    internal.error = 'old account error';
    internal.activeNegotiations = 4;
    internal.checkedNegotiations = 3;
    internal.unreadMessages = 2;
    internal.conversations = [{
      key: 'negotiation-1',
      vacancyTitle: 'QA',
      companyName: 'Example',
      lastMessage: 'Здравствуйте',
      lastMessageMine: false,
      hasUnread: true,
      needsUserInput: true,
      stage: 'hr',
      updatedAt: new Date().toISOString(),
    }];
    internal.pendingDecisions = [{
      id: 'decision-1',
      negotiationKey: 'negotiation-1',
      messageId: 'message-1',
      vacancyTitle: 'QA',
      companyName: 'Example',
      recruiterMessage: 'Когда готовы выйти?',
      kind: 'start_date',
      createdAt: new Date().toISOString(),
    }];
    internal.confirmedFacts = [{
      id: 'fact-1',
      kind: 'schedule',
      question: 'Какой график?',
      answer: 'Удалённый',
      updatedAt: new Date().toISOString(),
    }];

    const state = chat.resetAccountSession();

    expect(state).toMatchObject({
      enabled: false,
      polling: false,
      error: null,
      activeNegotiations: 0,
      checkedNegotiations: 0,
      unreadMessages: 0,
      conversations: [],
      pendingDecisions: [],
    });
    expect(state.confirmedFacts).toHaveLength(1);
  });

  it('ignores a poll that finishes after the account was reset', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-logout-race-'));
    directories.push(userDataDir);
    let finishPageLookup: ((page: null) => void) | undefined;
    const pageLookup = new Promise<null>((resolve) => { finishPageLookup = resolve; });
    const chat = new HhChatBrowser(
      userDataDir,
      async () => pageLookup,
      async () => '',
    );

    const polling = chat.pollNow();
    await Promise.resolve();
    chat.resetAccountSession();
    finishPageLookup?.(null);
    await polling;

    expect(chat.getState()).toMatchObject({
      enabled: false,
      polling: false,
      error: null,
      conversations: [],
      pendingDecisions: [],
    });
  });

  it('does not continue scraping an old-account chat after reset', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-chat-logout-mid-poll-'));
    directories.push(userDataDir);
    const page = {
      isClosed: () => false,
      url: () => 'https://hh.ru/applicant/negotiations',
      locator: () => ({
        first: () => ({
          waitFor: async () => undefined,
        }),
      }),
    };
    const chat = new HhChatBrowser(
      userDataDir,
      async () => page as never,
      async () => '',
    );
    let finishOpeningChat: ((frame: unknown) => void) | undefined;
    let markChatOpeningStarted: (() => void) | undefined;
    const chatOpeningStarted = new Promise<void>((resolve) => { markChatOpeningStarted = resolve; });
    const openingChat = new Promise<unknown>((resolve) => { finishOpeningChat = resolve; });
    const scrapeMessages = vi.fn(async () => []);
    const internal = chat as unknown as {
      findNegotiationsPage: () => Promise<Array<Record<string, unknown>>>;
      openNegotiation: () => Promise<unknown>;
      scrapeMessages: typeof scrapeMessages;
      scrapeLastMessage: () => Promise<null>;
    };
    internal.findNegotiationsPage = async () => [{
      key: 'negotiation-old',
      vacancyTitle: 'QA',
      companyName: 'Old account company',
      vacancyUrl: 'https://hh.ru/vacancy/123',
      isRejected: false,
      hasUnread: true,
    }];
    internal.openNegotiation = async () => {
      markChatOpeningStarted?.();
      return openingChat;
    };
    internal.scrapeMessages = scrapeMessages;
    internal.scrapeLastMessage = async () => null;

    const polling = chat.pollNow();
    await chatOpeningStarted;
    chat.resetAccountSession();
    finishOpeningChat?.({
      locator: () => ({ innerText: async () => '' }),
    });
    await polling;

    expect(scrapeMessages).not.toHaveBeenCalled();
    expect(chat.getState()).toMatchObject({
      enabled: false,
      error: null,
      conversations: [],
      pendingDecisions: [],
    });
  });
});
