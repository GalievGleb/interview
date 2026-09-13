import { expect, it, vi } from 'vitest';
import { resumeHomeQueue } from './resumeHomeQueue';

it('resumes the queue before opening its page', async () => {
  const order: string[] = [];
  const state = { queuePaused: false };
  const result = await resumeHomeQueue({ applyAll: async () => { order.push('resume'); return state; } }, () => order.push('navigate'));
  expect(order).toEqual(['resume', 'navigate']);
  expect(result).toBe(state);
});

it('does not hide a failed resume by navigating away', async () => {
  const navigate = vi.fn();
  await expect(resumeHomeQueue({ applyAll: async () => { throw new Error('Resume failed'); } }, navigate)).rejects.toThrow('Resume failed');
  expect(navigate).not.toHaveBeenCalled();
});
