import { describe, expect, it } from 'vitest';
import {
  getAppIdentity,
  localApiConnectSources,
  resolveBuildChannel,
} from './buildChannel';

describe('desktop build channel', () => {
  it('treats source development as the dev channel', () => {
    expect(resolveBuildChannel(false, undefined)).toBe('dev');
  });

  it('defaults packaged builds to stable for backwards compatibility', () => {
    expect(resolveBuildChannel(true, undefined)).toBe('stable');
    expect(resolveBuildChannel(true, 'unexpected')).toBe('stable');
  });

  it('recognizes the packaged alpha channel without changing source development', () => {
    expect(resolveBuildChannel(true, 'alpha')).toBe('alpha');
    expect(resolveBuildChannel(false, 'alpha')).toBe('dev');
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

  it('keeps Alpha isolated from both stable and dev while preserving the keyboard contract', () => {
    const stable = getAppIdentity('stable');
    const dev = getAppIdentity('dev');
    const alpha = getAppIdentity('alpha');

    expect(alpha).toMatchObject({
      channel: 'alpha',
      displayName: 'SkillCue Alpha',
      appUserModelId: 'com.interview.assistant.alpha',
      deepLinkProtocol: 'skillcue-alpha',
      apiPort: 8002,
      userDataDirectoryName: 'SkillCue Alpha',
    });
    expect(alpha.apiPort).not.toBe(stable.apiPort);
    expect(alpha.apiPort).not.toBe(dev.apiPort);
    expect(alpha.appUserModelId).not.toBe(dev.appUserModelId);
    expect(alpha.deepLinkProtocol).not.toBe(dev.deepLinkProtocol);
    expect(alpha.defaultToggleShortcut).toBe(stable.defaultToggleShortcut);
    expect(alpha.forceAnswerShortcut).toBe(stable.forceAnswerShortcut);
    expect(alpha.forceScreenAnswerShortcut).toBe(stable.forceScreenAnswerShortcut);
  });

  it.each([
    ['stable', 8000],
    ['dev', 8001],
    ['alpha', 8002],
  ] as const)('allows the packaged %s renderer to reach its own local API port', (channel, port) => {
    expect(localApiConnectSources(getAppIdentity(channel))).toEqual([
      `http://127.0.0.1:${port}`,
      `ws://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `ws://localhost:${port}`,
    ]);
  });
});
