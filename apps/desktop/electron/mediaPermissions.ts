export type InterviewMediaPermission = 'microphone' | 'screen';
export type InterviewMediaPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export function macPrivacyPaneUrl(kind: InterviewMediaPermission): string {
  const pane = kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture';
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}

export function shouldOpenMediaSettings(status: InterviewMediaPermissionStatus): boolean {
  return status === 'denied' || status === 'restricted';
}
