// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import MarkdownText from './MarkdownText';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('copies exact SQL through the desktop bridge when the overlay cannot take focus', async () => {
  let clipboard = '';
  vi.stubGlobal('electronAPI', undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    writeClipboardText: async (text: string) => { clipboard = text; },
  } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async () => { throw new Error('Document is not focused'); },
  } });
  render(<MarkdownText text={'```sql\nSELECT owner_id FROM Rooms;\n```'} />);
  fireEvent.click(screen.getByRole('button', { name: 'Копировать код' }));
  await waitFor(() => expect(clipboard).toBe('SELECT owner_id FROM Rooms;'));
  expect(screen.getByText('Скопировано')).toBeTruthy();
});

it('shows a copy error instead of claiming success when the clipboard rejects the write', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    writeClipboardText: async () => { throw new Error('Clipboard unavailable'); },
  } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async () => { throw new Error('Document is not focused'); },
  } });
  render(<MarkdownText text={'```sql\nSELECT 1;\n```'} />);
  fireEvent.click(screen.getByRole('button', { name: 'Копировать код' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Не удалось скопировать'));
  expect(screen.queryByText('Скопировано')).toBeNull();
});
