export type BuildChannel = 'stable' | 'dev';

export interface AppIdentity {
  channel: BuildChannel;
  displayName: string;
  appUserModelId: string;
  deepLinkProtocol: string;
  apiPort: number;
  userDataDirectoryName: string | null;
  defaultToggleShortcut: string;
  forceAnswerShortcut: string;
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
};

export function resolveBuildChannel(
  isPackaged: boolean,
  packagedChannel: unknown,
): BuildChannel {
  if (!isPackaged) return 'dev';
  return packagedChannel === 'dev' ? 'dev' : 'stable';
}

export function getAppIdentity(channel: BuildChannel): AppIdentity {
  return channel === 'dev' ? DEV_IDENTITY : STABLE_IDENTITY;
}
