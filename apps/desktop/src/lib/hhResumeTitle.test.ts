import { describe, expect, it } from 'vitest';
import { compactHhResumeTitle } from './hhResumeTitle';

describe('compact HH résumé title', () => {
  it('keeps the role and salary while removing duplicated employment metadata', () => {
    expect(
      compactHhResumeTitle(
        'Постоянная работа, подработка Qa Fullstack engineer python 240 000 ₽ · Удалённо',
      ),
    ).toBe('QA Fullstack engineer python 240 000 ₽');
  });

  it('does not alter an already concise title', () => {
    expect(compactHhResumeTitle('QA Automation Python 220 000 ₽')).toBe(
      'QA Automation Python 220 000 ₽',
    );
  });
});
