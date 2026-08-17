import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const setupSource = fs.readFileSync(
  path.resolve(__dirname, 'GeneralPracticeSetup.tsx'),
  'utf8',
);

describe('general practice resume context', () => {
  it('loads the same preferred résumé as Home, including HH', () => {
    expect(setupSource).toContain('resolvePreferredResume');
    expect(setupSource).toContain('skillcue:candidate-sources-updated');
    expect(setupSource).toContain('Резюме подключено');
    expect(setupSource).not.toContain('listSessions().find');
  });
});
