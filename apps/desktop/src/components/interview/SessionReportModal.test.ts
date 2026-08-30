import React, { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../Modal', () => ({
  default: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) =>
    React.createElement('div', null, children, footer),
}));

import SessionReportModal from './SessionReportModal';

const session = {
  id: 'session-1',
  mode: 'interview',
  title: 'Техническое интервью',
  started_at: '2026-08-29T10:00:00.000Z',
  ended_at: '2026-08-29T10:30:00.000Z',
};

describe('SessionReportModal', () => {
  it('offers a local report file without requiring a consent checkbox', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionReportModal, { session, onClose: () => undefined }),
    );

    expect(html).toContain('Открыть файл');
    expect(html).toContain('Прикрепить в Telegram');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Я согласен отправить');
  });
});
