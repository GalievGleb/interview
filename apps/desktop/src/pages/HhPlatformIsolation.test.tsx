// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import HhApplicationsPage from './HhApplicationsPage';

vi.mock('../context/AppContext', () => ({ useApp: () => ({ license: null, loading: false }) }));
afterEach(cleanup);

async function mountRunningHh() {
  const state = {
    phase: 'scanning', browserOpen: false, loginRequired: true,
    message: 'Ищем вакансии HH: QA Automation', applying: false,
    stopRequested: false, queuePaused: false, applyProgress: null,
    currentVacancyId: null, queue: [], screeningFacts: [], runHistory: [],
    lastScanSummary: null, nextRunAt: null, nextQueueResumeAt: null,
    verificationCooldownUntil: null, updatedAt: new Date().toISOString(),
    config: { platform: 'hh', query: 'QA Automation', includeRelatedQueries: true,
      additionalQueries: [], area: '', experience: '', employment: '', schedule: 'remote',
      salaryFrom: null, onlyWithSalary: false, excludedKeywords: [], excludedEmployers: [],
      maxQueueSize: 5000, maxPages: 20, coverLetterTemplate: '', autoSend: false,
      resumeTitleContains: '', resumeTitles: [], delayBetweenSec: 20, dailyLimit: 20,
      autoRunDaily: false, autoRunHour: 10, linkedinLocation: '', linkedinEasyApplyOnly: true,
      avitoCity: 'all' },
  };
  const assistant = { getState: vi.fn(async () => state), onState: vi.fn(() => () => {}),
    openBrowser: vi.fn(), saveConfig: vi.fn(), stop: vi.fn() };
  window.electronAPI = { hhAssistant: assistant } as unknown as typeof window.electronAPI;
  render(<MemoryRouter initialEntries={['/applications?mode=settings']}><HhApplicationsPage /></MemoryRouter>);
  await screen.findByText('Подключите аккаунт HH');
  return assistant;
}

it('does not present the HH search as a LinkedIn search when changing tabs', async () => {
  const assistant = await mountRunningHh();
  fireEvent.click(screen.getByRole('button', { name: /LinkedIn/ }));
  expect(screen.queryByText('Ищем вакансии HH: QA Automation')).toBeNull();
  expect(screen.getByText('Подключите LinkedIn')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Открыть площадку' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /HH.ru/ }));
  expect(screen.getByText('Подключите аккаунт HH')).toBeTruthy();
  expect(assistant.openBrowser).not.toHaveBeenCalled();
  expect(assistant.saveConfig).not.toHaveBeenCalled();
  expect(assistant.stop).not.toHaveBeenCalled();
});

it('shows Avito as in development without connection or search actions', async () => {
  await mountRunningHh();
  fireEvent.click(screen.getByRole('button', { name: /Avito Работа/ }));
  expect(screen.getByRole('heading', { name: 'Поиск работы в разработке' })).toBeTruthy();
  expect(screen.queryByText('Ищем вакансии HH: QA Automation')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Открыть площадку' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Найти вакансии/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Активность' }));
  expect(screen.getByRole('heading', { name: 'Поиск работы в разработке' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Запустить поиск|Остановить/ })).toBeNull();
});
