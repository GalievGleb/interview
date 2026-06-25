import { describe, expect, it } from 'vitest';
import { buildRevisionStreamOpts } from './answerRevision';

describe('answerRevision', () => {
  it('adds shorter strategy with previous answer', () => {
    const opts = buildRevisionStreamOpts(
      { questionIntent: 'technical_definition' },
      'shorter',
      'Long answer about pytest fixtures and scopes.',
    );
    expect(opts.answerStrategy).toContain('40–55 words');
    expect(opts.answerStrategy).toContain('Long answer about pytest');
    expect(opts.resumeContextUsed).toBe(false);
  });

  it('keeps opts unchanged for regenerate', () => {
    const base = { questionIntent: 'technical_list', answerStrategy: 'list items' };
    const opts = buildRevisionStreamOpts(base, 'regenerate', 'previous');
    expect(opts).toEqual(base);
  });
});
