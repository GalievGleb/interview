import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('./Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <section data-testid="desktop-shell">{children}</section>
  ),
}));

import StartupGate from './StartupGate';

it('renders the application shell immediately while startup services warm up', () => {
  const html = renderToStaticMarkup(
    <StartupGate><p>Главная</p></StartupGate>,
  );

  expect(html).toContain('data-testid="desktop-shell"');
  expect(html).toContain('Главная');
});
