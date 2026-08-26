import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HhBrowserAssistant,
  type HhAssistantState,
} from './hhBrowserAssistant';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('HH manual search launch', () => {
  it('retries an explicit manual search during an automatic HH verification cooldown', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-manual-search-'));
    tempDirs.push(userDataDir);
    const assistant = new HhBrowserAssistant(userDataDir, () => undefined);
    const internal = assistant as unknown as {
      state: HhAssistantState;
      scan: HhBrowserAssistant['scan'];
      verificationResumeTimer: NodeJS.Timeout | null;
    };
    internal.state.config.autoSend = false;
    internal.state.verificationCooldownUntil = new Date(Date.now() + 9 * 60 * 60_000).toISOString();
    internal.scan = vi.fn(async () => assistant.getState());

    await assistant.runNow('manual');

    expect(internal.scan).toHaveBeenCalledOnce();
    expect(assistant.getState().verificationCooldownUntil).toBeNull();
    if (internal.verificationResumeTimer) clearTimeout(internal.verificationResumeTimer);
  });

  it('keeps an automatic scheduled search paused during the same cooldown', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-hh-scheduled-search-'));
    tempDirs.push(userDataDir);
    const assistant = new HhBrowserAssistant(userDataDir, () => undefined);
    const internal = assistant as unknown as {
      state: HhAssistantState;
      scan: HhBrowserAssistant['scan'];
      verificationResumeTimer: NodeJS.Timeout | null;
    };
    const cooldownUntil = new Date(Date.now() + 9 * 60 * 60_000).toISOString();
    internal.state.verificationCooldownUntil = cooldownUntil;
    internal.scan = vi.fn(async () => assistant.getState());

    await assistant.runNow('schedule');

    expect(internal.scan).not.toHaveBeenCalled();
    expect(assistant.getState().verificationCooldownUntil).toBe(cooldownUntil);
    expect(assistant.getState().message).toContain('Автоотклики безопасно приостановлены');
    if (internal.verificationResumeTimer) clearTimeout(internal.verificationResumeTimer);
  });
});
