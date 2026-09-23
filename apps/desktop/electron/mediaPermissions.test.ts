import { describe, expect, it } from 'vitest';
import { macPrivacyPaneUrl, shouldOpenMediaSettings } from './mediaPermissions';

describe('macOS media permission helpers', () => {
  it('opens the exact privacy pane for each interview input', () => {
    expect(macPrivacyPaneUrl('microphone')).toContain('Privacy_Microphone');
    expect(macPrivacyPaneUrl('screen')).toContain('Privacy_ScreenCapture');
  });

  it('only redirects after macOS has blocked a permission', () => {
    expect(shouldOpenMediaSettings('denied')).toBe(true);
    expect(shouldOpenMediaSettings('restricted')).toBe(true);
    expect(shouldOpenMediaSettings('not-determined')).toBe(false);
    expect(shouldOpenMediaSettings('granted')).toBe(false);
  });
});
