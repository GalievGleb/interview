import { describe, expect, it } from 'vitest';
import { shouldShowUpdateButton } from './updaterPrompt';

describe('shouldShowUpdateButton', () => {
  it('shows the right-side Update button while a newer build exists', () => {
    expect(shouldShowUpdateButton('available')).toBe(true);
    expect(shouldShowUpdateButton('downloading')).toBe(true);
    expect(shouldShowUpdateButton('ready')).toBe(true);
    expect(shouldShowUpdateButton('waiting-for-session-end')).toBe(true);
    expect(shouldShowUpdateButton('installing')).toBe(true);
  });

  it('hides the button when there is nothing to install', () => {
    expect(shouldShowUpdateButton('idle')).toBe(false);
    expect(shouldShowUpdateButton('checking')).toBe(false);
    expect(shouldShowUpdateButton('none')).toBe(false);
    expect(shouldShowUpdateButton('error')).toBe(false);
  });
});
