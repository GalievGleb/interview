import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HhBrowserAssistant } from './hhBrowserAssistant';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-search-recovery-'));
  directories.push(directory);
  const assistant = new HhBrowserAssistant(directory, () => undefined);
  const internal = assistant as any;
  internal.state.config.query = 'QA Automation Python';
  internal.state.config.platform = 'hh';
  internal.getConfiguredSearchResumeContext = async () => '';
  internal.resetBrowserConnection = async () => undefined;
  internal.detectManualBlocker = async () => 'Войдите в HH для продолжения.';
  return { assistant, internal };
}

describe('HH search browser loss', () => {
  it('recovers a closed search browser and reaches the actual login check', async () => {
    const { assistant, internal } = setup();
    internal.ensureBrowser = vi.fn()
      .mockRejectedValueOnce(new Error('page.waitForTimeout: Target page, context or browser has been closed'))
      .mockResolvedValue({ goto: async () => undefined });
    const result = await assistant.scan('hh');
    expect(result.phase).toBe('manual_required');
    expect(result.message).toBe('Войдите в HH для продолжения.');
  });

  it('bounds recovery when the browser keeps closing', async () => {
    const { assistant, internal } = setup();
    internal.ensureBrowser = async () => { throw new Error('Target page, context or browser has been closed'); };
    const result = await assistant.scan('hh');
    expect(result.phase).toBe('error');
    expect(result.message).toContain('Не удалось восстановить браузер поиска');
  });

  it('does not replace the active run settings while switching platforms', () => {
    const { assistant, internal } = setup();
    internal.automationRunInFlight = true;
    assistant.saveConfig({ platform: 'linkedin', query: 'Java' });
    expect(assistant.getState().config.platform).toBe('hh');
    expect(assistant.getState().config.query).toBe('QA Automation Python');
  });
});
