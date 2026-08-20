import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HhBrowserAssistant,
  type HhAssistantState,
  type HhQueueItem,
} from './hhBrowserAssistant';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HH automation stop', () => {
  it('does not send an eleventh application on the free trial even when configured higher', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-trial-cap-'));
    tempDirs.push(userDataDir);
    const assistant = new HhBrowserAssistant(
      userDataDir, () => undefined, undefined, undefined, async () => 'trial',
    );
    const now = new Date().toISOString();
    const template: HhQueueItem = {
      id: 'pending', key: 'hh:pending', platform: 'hh', title: 'QA', company: 'Acme',
      salary: '', url: 'https://hh.ru/vacancy/pending', status: 'new', addedAt: now,
    };
    const internal = assistant as unknown as {
      state: HhAssistantState;
      applyToVacancy: (item: HhQueueItem) => Promise<never>;
      runQueue: () => Promise<{ attempted: number }>;
    };
    internal.state.config.dailyLimit = 200;
    internal.state.queue = [
      ...Array.from({ length: 10 }, (_, index) => ({
        ...template, id: `sent-${index}`, key: `hh:sent-${index}`,
        status: 'sent' as const, sentAt: now,
      })),
      template,
    ];
    internal.applyToVacancy = vi.fn(async () => { throw new Error('must not send'); });

    expect(await internal.runQueue()).toMatchObject({ attempted: 0 });
    expect(internal.applyToVacancy).not.toHaveBeenCalled();
    expect(assistant.getState().message).toContain('отправлено сегодня 10');
  });

  it('persists a user pause and clears it only when a new run is explicitly started', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-stop-'));
    tempDirs.push(userDataDir);

    const assistant = new HhBrowserAssistant(userDataDir, () => undefined);
    (assistant as unknown as { automationRunInFlight: boolean }).automationRunInFlight = true;

    const stopped = assistant.stopApply();
    expect(stopped).toMatchObject({
      stopRequested: true,
      queuePaused: true,
    });

    const restored = new HhBrowserAssistant(userDataDir, () => undefined);
    expect(restored.getState()).toMatchObject({
      stopRequested: false,
      queuePaused: true,
    });

    await restored.runNow('manual');
    expect(restored.getState().queuePaused).toBe(false);
  });

  it('finishes the current vacancy, skips the next one, and does not schedule a retry', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-stop-'));
    tempDirs.push(userDataDir);

    const assistant = new HhBrowserAssistant(userDataDir, () => undefined);
    const first: HhQueueItem = {
      id: '101',
      key: 'hh:101',
      platform: 'hh',
      title: 'QA Automation Engineer',
      company: 'First',
      salary: '',
      url: 'https://hh.ru/vacancy/101',
      status: 'new',
      addedAt: new Date().toISOString(),
    };
    const second: HhQueueItem = {
      ...first,
      id: '102',
      key: 'hh:102',
      company: 'Second',
      url: 'https://hh.ru/vacancy/102',
    };
    const internal = assistant as unknown as {
      state: HhAssistantState;
      applyToVacancy: (item: HhQueueItem) => Promise<{
        sent: boolean;
        alreadyApplied: boolean;
        blocked: boolean;
        reason: string;
      }>;
      runQueue: () => Promise<{
        attempted: number;
        stopped: boolean;
      }>;
      queueResumeTimer: NodeJS.Timeout | null;
    };
    internal.state.queue = [first, second];
    internal.applyToVacancy = vi.fn(async () => {
      assistant.stopApply();
      return { sent: false, alreadyApplied: false, blocked: false, reason: 'done' };
    });

    const stats = await internal.runQueue();

    expect(internal.applyToVacancy).toHaveBeenCalledOnce();
    expect(stats).toMatchObject({ attempted: 1, stopped: true });
    expect(assistant.getState()).toMatchObject({
      stopRequested: false,
      queuePaused: true,
      applying: false,
    });
    expect(internal.queueResumeTimer).toBeNull();
  });
});
