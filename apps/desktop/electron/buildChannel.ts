export type BuildChannel = 'stable' | 'dev' | 'alpha';

export interface AppIdentity {
  channel: BuildChannel;
  displayName: string;
  appUserModelId: string;
  deepLinkProtocol: string;
  apiPort: number;
  userDataDirectoryName: string | null;
  defaultToggleShortcut: string;
  forceAnswerShortcut: string;
  forceScreenAnswerShortcut: string;
}

const STABLE_IDENTITY: AppIdentity = {
  channel: 'stable',
  displayName: 'SkillCue',
  appUserModelId: 'com.interview.assistant',
  deepLinkProtocol: 'skillcue',
  apiPort: 8000,
  // Keep Electron's existing path so installed users retain all settings/data.
  userDataDirectoryName: null,
  defaultToggleShortcut: 'CommandOrControl+Shift+H',
  forceAnswerShortcut: 'CommandOrControl+Enter',
  forceScreenAnswerShortcut: 'CommandOrControl+Shift+Enter',
};

const DEV_IDENTITY: AppIdentity = {
  channel: 'dev',
  displayName: 'SkillCue Dev',
  appUserModelId: 'com.interview.assistant.dev',
  deepLinkProtocol: 'skillcue-dev',
  apiPort: 8001,
  userDataDirectoryName: 'SkillCue Dev',
  // Keyboard behavior is a user-facing contract, not part of build isolation.
  // Dev already has a separate process identity, data directory and API port;
  // changing the shortcuts made the labels lie and broke use from other apps.
  defaultToggleShortcut: 'CommandOrControl+Shift+H',
  forceAnswerShortcut: 'CommandOrControl+Enter',
  forceScreenAnswerShortcut: 'CommandOrControl+Shift+Enter',
};

const ALPHA_IDENTITY: AppIdentity = {
  channel: 'alpha',
  displayName: 'SkillCue Alpha',
  appUserModelId: 'com.interview.assistant.alpha',
  deepLinkProtocol: 'skillcue-alpha',
  apiPort: 8002,
  userDataDirectoryName: 'SkillCue Alpha',
  defaultToggleShortcut: 'CommandOrControl+Shift+H',
  forceAnswerShortcut: 'CommandOrControl+Enter',
  forceScreenAnswerShortcut: 'CommandOrControl+Shift+Enter',
};

export function resolveBuildChannel(
  isPackaged: boolean,
  packagedChannel: unknown,
): BuildChannel {
  if (!isPackaged) return 'dev';
  if (packagedChannel === 'alpha') return 'alpha';
  return packagedChannel === 'dev' ? 'dev' : 'stable';
}

export function getAppIdentity(channel: BuildChannel): AppIdentity {
  if (channel === 'alpha') return ALPHA_IDENTITY;
  return channel === 'dev' ? DEV_IDENTITY : STABLE_IDENTITY;
}

export function localApiConnectSources(identity: AppIdentity): string[] {
  const port = identity.apiPort;
  return [
    `http://127.0.0.1:${port}`,
    `ws://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `ws://localhost:${port}`,
  ];
}
