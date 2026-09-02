import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CANDIDATE_FOLLOW_UP_ACCELERATOR,
  PRODUCT_ACCELERATOR_INVENTORY,
  SIDEBAR_TOGGLE_ACCELERATOR,
  isReservedOverlayShortcut,
} from './shortcutPolicy';

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

  it.each([
    'CommandOrControl+\\',
    'Ctrl+\\',
    'Control + \\',
    'Command+\\',
    'Cmd+\\',
  ])('reserves %s for the candidate follow-up command', (shortcut) => {
    expect(isReservedOverlayShortcut(shortcut)).toBe(true);
  });

  it('allows the normal overlay toggle shortcut', () => {
    expect(isReservedOverlayShortcut('CommandOrControl+Shift+H')).toBe(false);
  });

  it('assigns every product action a distinct accelerator owner', () => {
    const normalized = PRODUCT_ACCELERATOR_INVENTORY.map(({ accelerator }) =>
      accelerator.replace(/\s+/g, '').toLowerCase(),
    );
    expect(new Set(normalized).size).toBe(normalized.length);
    expect(CANDIDATE_FOLLOW_UP_ACCELERATOR).toBe('CommandOrControl+\\');
    expect(SIDEBAR_TOGGLE_ACCELERATOR).toBe('Control+B');
  });

  it('keeps registered and documented candidate/sidebar accelerators aligned', () => {
    const main = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');
    const sidebar = fs.readFileSync(path.resolve(__dirname, '../src/components/Sidebar.tsx'), 'utf8');
    expect(main).toContain('CANDIDATE_FOLLOW_UP_ACCELERATOR');
    expect(sidebar).not.toContain('Control+Backslash');
    expect(sidebar).not.toContain('Ctrl+\\`');
    expect(sidebar).toContain(`aria-keyshortcuts="${SIDEBAR_TOGGLE_ACCELERATOR}"`);
  });
});
