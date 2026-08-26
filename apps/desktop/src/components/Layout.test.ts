import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../context/AppContext', () => ({
  useApp: () => ({ backendOnline: true, backendStatus: { state: 'ready' } }),
}));

vi.mock('../lib/i18n', () => ({
  getLang: () => 'ru',
  setLang: () => undefined,
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
      'shell.skipContent': 'К содержимому',
      'shell.loading': 'Загрузка',
      'shell.backendFailed': 'Ошибка',
      'shell.backendConnecting': 'Подключение',
      'shell.liveSession': 'Сессия',
      'update.apply': 'Обновить',
    }[key] ?? key),
  }),
}));

vi.mock('../lib/theme', () => ({
  useTheme: () => ({ pref: 'dark', setPref: () => undefined }),
}));

vi.mock('../hooks/useUpdaterStatus', () => ({ useUpdaterStatus: () => null }));

import Layout from './Layout';

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
      requestAnimationFrame: () => 0,
      electronAPI: undefined,
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { title: '' },
  });
}

describe('desktop shell structure', () => {
  beforeEach(installBrowserStubs);

  it('lets the sidebar own the full window height and keeps the titlebar inside content', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/home'] },
        React.createElement(Layout, null, React.createElement('p', null, 'Контент')),
      ),
    );

    const sidebarAt = html.indexOf('skillcue-sidebar');
    const mainAt = html.indexOf('id="skillcue-main"');
    const titlebarAt = html.indexOf('skillcue-titlebar');
    expect(sidebarAt).toBeGreaterThanOrEqual(0);
    expect(mainAt).toBeGreaterThan(sidebarAt);
    expect(titlebarAt).toBeGreaterThan(mainAt);
    expect(html).toContain('skillcue-shell');
  });
});
