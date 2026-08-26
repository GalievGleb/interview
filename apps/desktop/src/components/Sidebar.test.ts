import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../context/AppContext', () => ({
  useApp: () => ({ backendStatus: { state: 'ready' } }),
}));

vi.mock('../lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => ({
      'nav.home': 'Главная',
      'nav.prepare': 'Разбор вакансии',
      'nav.applications': 'Отклики',
      'nav.calendar': 'Календарь',
      'nav.documents': 'Профиль и опыт',
      'nav.practice': 'Практика',
      'nav.history': 'Интервью',
      'nav.settings': 'Настройки',
      'sidebar.mainNav': 'Основная навигация',
      'sidebar.openLiveOverlay': 'Открыть помощника',
      'sidebar.liveNow': 'В эфире',
      'sidebar.expand': 'Развернуть',
      'sidebar.collapse': 'Свернуть',
      'sidebar.unavailable': 'Недоступно',
      'sidebar.stealthTitle': 'Скрывать помощника',
      'sidebar.taskbarTitle': 'Скрывать из панели задач',
    }[key] ?? key),
  }),
}));

vi.mock('../lib/theme', () => ({
  useTheme: () => ({ pref: 'dark', setPref: () => undefined }),
}));

import Sidebar, { nextSidebarTheme } from './Sidebar';

function installBrowserStubs(): void {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: undefined,
    },
  });
}

describe('canonical desktop sidebar', () => {
  beforeEach(installBrowserStubs);

  it('renders the full product navigation and a dedicated assistant card', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/home'] },
        React.createElement(Sidebar),
      ),
    );

    for (const label of [
      'Главная',
      'Разбор вакансии',
      'Отклики',
      'Календарь',
      'Профиль и опыт',
      'Практика',
      'Интервью',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('skillcue-sidebar__assistant-card');
    expect(html).toContain('aria-label="Открыть помощника"');
    expect(html).toContain('width="48"');
    expect(html).toContain('aria-label="Скрывать из панели задач"');
    expect(html).toContain('Переключить тему');
  });

  it('cycles the sidebar moon action between the two explicit app themes', () => {
    expect(nextSidebarTheme('dark')).toBe('light');
    expect(nextSidebarTheme('light')).toBe('dark');
    expect(nextSidebarTheme('system')).toBe('light');
  });
});
