import { describe, expect, it } from 'vitest';
import { isReservedOverlayShortcut } from './shortcutPolicy';

describe('isReservedOverlayShortcut', () => {
  it.each([
    'CommandOrControl+Enter',
    'Ctrl+Enter',
    'Control + Enter',
    'Command+Enter',
    'Cmd+Enter',
    'CommandOrControl+Shift+Enter',
    'Ctrl+Shift+Enter',
    'Control + Shift + Enter',
    'Command+Shift+Enter',
    'Cmd+Shift+Enter',
  ])('reserves %s for forced live answers', (shortcut) => {
    expect(isReservedOverlayShortcut(shortcut)).toBe(true);
  });

  it('allows the normal overlay toggle shortcut', () => {
    expect(isReservedOverlayShortcut('CommandOrControl+Shift+H')).toBe(false);
  });
});
