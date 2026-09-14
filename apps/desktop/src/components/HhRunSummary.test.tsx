// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HhRunSummary from './HhRunSummary';

afterEach(cleanup);
describe('Applications run summary', () => {
  it('shows sent results without presenting internal attention as a user task', () => {
    render(<HhRunSummary sent={10} status="attention" repliesToday={2} autoReplies onRetry={() => {}} />);
    expect(screen.getByText('Отправлено откликов: 10')).toBeTruthy();
    expect(screen.getByText('Сегодня отправлено ответов: 2')).toBeTruthy();
    expect(screen.queryByText(/Нужно внимание|Диагностика|Очередь пуста/)).toBeNull();
  });
  it('gives a concrete retry action when the search actually fails', () => {
    const retry = vi.fn();
    render(<HhRunSummary sent={0} status="failed" repliesToday={0} autoReplies={false} onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить поиск' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByText('Автоответы выключены')).toBeTruthy();
  });
});
