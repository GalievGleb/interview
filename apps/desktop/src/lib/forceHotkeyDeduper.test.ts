import { describe, expect, it } from 'vitest';
import { acceptForceHotkey, type ForceHotkeyEvent } from './forceHotkeyDeduper';

describe('acceptForceHotkey', () => {
  it('suppresses only the renderer/global duplicate from one physical press', () => {
    const first: ForceHotkeyEvent = { source: 'global', at: 1_000 };

    expect(acceptForceHotkey(null, first)).toBe(true);
    expect(acceptForceHotkey(first, { source: 'renderer', at: 1_020 })).toBe(false);
  });

  it('accepts a deliberate second press even inside the duplicate window', () => {
    const first: ForceHotkeyEvent = { source: 'global', at: 1_000 };

    expect(acceptForceHotkey(first, { source: 'global', at: 1_080 })).toBe(true);
  });

  it('never suppresses a button action', () => {
    const first: ForceHotkeyEvent = { source: 'renderer', at: 1_000 };

    expect(acceptForceHotkey(first, { source: 'button', at: 1_010 })).toBe(true);
  });
});
