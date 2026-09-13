// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HhHrProfilePage from './HhHrProfilePage';

afterEach(() => { cleanup(); localStorage.clear(); });

it('prefetches unseen questions with bounded concurrency and preserves edits', async () => {
  const resolves = new Map<string, (value: unknown) => void>();
  const state = { screeningFacts: [], queue: [{ key: 'hh:1', id: '1', platform: 'hh',
    title: 'QA', company: 'Example', status: 'needs_input',
    pendingQuestions: ['Первый вопрос?', 'Второй вопрос?', 'Третий вопрос?'].map((prompt, i) =>
      ({ id: String(i), prompt, kind: 'text', required: true, options: [] })),
  }] };
  const suggest = vi.fn((_vacancy, id: string) => new Promise((resolve) => resolves.set(id, resolve)));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { hhAssistant: {
    getState: async () => state, onState: () => () => {}, suggestScreeningAnswer: suggest,
  } } });
  render(React.createElement(MemoryRouter, null, React.createElement(HhHrProfilePage)));
  const field = await screen.findByRole('textbox', { name: 'Первый вопрос?' });
  await waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
  expect(resolves.has('1')).toBe(true); // Not yet visited, already preparing.
  expect(resolves.has('2')).toBe(false); // Only two requests in flight.
  fireEvent.change(field, { target: { value: 'Мой собственный ответ' } });
  await act(async () => resolves.get('0')!({ answer: 'Запоздалый черновик', selectedOptions: [], source: 'ai' }));
  expect((field as HTMLTextAreaElement).value).toBe('Мой собственный ответ');
  await waitFor(() => expect(resolves.has('2')).toBe(true));
  await act(async () => {
    resolves.get('1')!({ answer: 'Готовый второй ответ', selectedOptions: [], source: 'ai' });
    resolves.get('2')!({ answer: 'Готовый третий ответ', selectedOptions: [], source: 'ai' });
  });
  fireEvent.click(screen.getByRole('button', { name: /Сохранить и дальше/ }));
  const second = await screen.findByRole('textbox', { name: 'Второй вопрос?' });
  expect((second as HTMLTextAreaElement).value).toBe('Готовый второй ответ');
  expect(suggest).toHaveBeenCalledTimes(3);
});
