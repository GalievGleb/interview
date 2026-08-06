import { describe, expect, it } from 'vitest';
import {
  canSendMore,
  countTodaySent,
  decideNextAction,
  jitterMs,
  nextAutoRunDelayMs,
} from './hhAutoApplyPolicy';

describe('hhAutoApplyPolicy', () => {
  describe('decideNextAction', () => {
    const ctx = {
      hasCoverLetter: true,
      resumeTitleContains: 'QA',
      resumeSelected: false,
      letterFilled: false,
      questionsFilled: false,
    };

    it('marks sent on success and already_applied', () => {
      expect(decideNextAction('success', ctx)).toEqual({ action: 'mark_sent' });
      expect(decideNextAction('already_applied', ctx)).toEqual({ action: 'mark_sent' });
    });

    it('waits for user on captcha and login', () => {
      expect(decideNextAction('captcha', ctx).action).toBe('wait_user');
      expect(decideNextAction('login', ctx).action).toBe('wait_user');
    });

    it('fills employer questions before continuing to confirmation', () => {
      expect(decideNextAction('employer_questions', ctx)).toEqual({ action: 'fill_questions' });
      expect(decideNextAction('employer_questions', { ...ctx, questionsFilled: true })).toEqual({
        action: 'click_confirm',
      });
    });

    it('skips on unknown', () => {
      expect(decideNextAction('unknown', ctx).action).toBe('skip');
    });

    it('clicks through response flow', () => {
      expect(decideNextAction('response_button', ctx)).toEqual({ action: 'click_response' });
      expect(decideNextAction('letter_offer', ctx)).toEqual({ action: 'open_letter' });
      expect(decideNextAction('letter_form', ctx)).toEqual({ action: 'fill_letter' });
      expect(decideNextAction('confirm', ctx)).toEqual({ action: 'click_confirm' });
    });

    it('skips letter fill when template empty or already filled', () => {
      const base = { ...ctx, hasCoverLetter: false, resumeTitleContains: '' };
      expect(decideNextAction('letter_form', base)).toEqual({ action: 'click_confirm' });
      expect(decideNextAction('letter_form', { ...ctx, letterFilled: true })).toEqual({
        action: 'click_confirm',
      });
      expect(decideNextAction('letter_offer', base)).toEqual({ action: 'click_confirm' });
      expect(decideNextAction('letter_offer', { ...ctx, letterFilled: true })).toEqual({
        action: 'click_confirm',
      });
    });

    it('selects resume only when substring configured and not yet selected', () => {
      expect(decideNextAction('resume_select', ctx)).toEqual({ action: 'select_resume' });
      expect(
        decideNextAction('resume_select', { ...ctx, resumeTitleContains: '' }),
      ).toEqual({ action: 'click_confirm' });
      expect(decideNextAction('resume_select', { ...ctx, resumeSelected: true })).toEqual({
        action: 'click_confirm',
      });
    });
  });

  describe('countTodaySent', () => {
    const now = new Date(2026, 6, 1, 15, 0, 0);

    it('counts only sent items from the same local day', () => {
      const queue = [
        { status: 'sent', sentAt: new Date(2026, 6, 1, 9, 0, 0).toISOString() },
        { status: 'sent', sentAt: new Date(2026, 6, 1, 14, 59, 59).toISOString() },
        { status: 'sent', sentAt: new Date(2026, 5, 30, 23, 59, 59).toISOString() },
        { status: 'skipped', sentAt: new Date(2026, 6, 1, 10, 0, 0).toISOString() },
        { status: 'sent' },
        { status: 'sent', sentAt: 'not-a-date' },
      ];
      expect(countTodaySent(queue, now)).toBe(2);
    });
  });

  describe('canSendMore', () => {
    it('respects the daily limit', () => {
      const now = new Date(2026, 6, 1, 12, 0, 0);
      const today = new Date(2026, 6, 1, 8, 0, 0).toISOString();
      expect(
        canSendMore({ dailyLimit: 2 }, [{ status: 'sent', sentAt: today }], now),
      ).toBe(true);
      expect(
        canSendMore(
          { dailyLimit: 2 },
          [
            { status: 'sent', sentAt: today },
            { status: 'sent', sentAt: today },
          ],
          now,
        ),
      ).toBe(false);
    });
  });

  describe('nextAutoRunDelayMs', () => {
    it('fires later today when the hour is ahead', () => {
      const now = new Date(2026, 6, 1, 9, 0, 0);
      expect(nextAutoRunDelayMs({ autoRunHour: 10 }, now)).toBe(3_600_000);
    });

    it('rolls to tomorrow when the hour has passed', () => {
      const now = new Date(2026, 6, 1, 10, 30, 0);
      // 23.5 часа до 10:00 следующего дня
      expect(nextAutoRunDelayMs({ autoRunHour: 10 }, now)).toBe(23.5 * 3_600_000);
    });

    it('rolls to tomorrow at the exact hour boundary', () => {
      const now = new Date(2026, 6, 1, 10, 0, 0);
      expect(nextAutoRunDelayMs({ autoRunHour: 10 }, now)).toBe(24 * 3_600_000);
    });
  });

  describe('jitterMs', () => {
    it('scales with injected random and clamps to 1s minimum', () => {
      expect(jitterMs(20, () => 0)).toBe(12_000);
      expect(jitterMs(20, () => 0.5)).toBe(20_000);
      expect(jitterMs(20, () => 1)).toBe(28_000);
      expect(jitterMs(0, () => 0)).toBe(1_000);
    });
  });
});
