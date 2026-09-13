// @vitest-environment jsdom
import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useOverlayPointer } from './useOverlayPointer';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('restores the stationary cursor hit region after toggling pass-through off', () => {
  const writes: boolean[] = [];
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    overlay: { setClickThrough: (value: boolean) => writes.push(value) },
  }});
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => ({ closest: () => ({}) }) });
  const { rerender } = renderHook(({ enabled }) => useOverlayPointer(enabled, false), {
    initialProps: { enabled: false },
  });
  act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 40 })));
  expect(writes.at(-1)).toBe(false);
  rerender({ enabled: true });
  expect(writes.at(-1)).toBe(true);
  rerender({ enabled: false });
  expect(writes.at(-1)).toBe(false);
});
