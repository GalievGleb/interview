import { describe, expect, it } from 'vitest';
import { getAppIdentity, resolveBuildChannel } from './buildChannel';

describe('desktop build channel', () => {
  it('treats source development as the dev channel', () => {
    expect(resolveBuildChannel(false, undefined)).toBe('dev');
  });

  it('defaults packaged builds to stable for backwards compatibility', () => {
    expect(resolveBuildChannel(true, undefined)).toBe('stable');
    expect(resolveBuildChannel(true, 'unexpected')).toBe('stable');
  });

  it('keeps stable and dev OS identities and runtime resources separate while preserving keyboard behavior', () => {
    const stable = getAppIdentity('stable');
    const dev = getAppIdentity('dev');

    expect(dev.displayName).not.toBe(stable.displayName);
    expect(dev.appUserModelId).not.toBe(stable.appUserModelId);
    expect(dev.deepLinkProtocol).not.toBe(stable.deepLinkProtocol);
    expect(dev.apiPort).not.toBe(stable.apiPort);
    expect(dev.userDataDirectoryName).toBeTruthy();
    expect(stable.userDataDirectoryName).toBeNull();
    expect(dev.defaultToggleShortcut).toBe('CommandOrControl+Shift+H');
    expect(dev.forceAnswerShortcut).toBe('CommandOrControl+Enter');
    expect(dev.forceScreenAnswerShortcut).toBe('CommandOrControl+Shift+Enter');
    expect(dev.defaultToggleShortcut).toBe(stable.defaultToggleShortcut);
    expect(dev.forceAnswerShortcut).toBe(stable.forceAnswerShortcut);
    expect(dev.forceScreenAnswerShortcut).toBe(stable.forceScreenAnswerShortcut);
  });
});
