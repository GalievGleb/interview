import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appContext = fs.readFileSync(
  path.resolve(__dirname, '../context/AppContext.tsx'),
  'utf8',
);

describe('session knowledge integration', () => {
  it('refreshes the durable weak-topic cache once after backend readiness', () => {
    expect(appContext).toContain("from '../lib/sessionKnowledge'");
    expect(appContext).toContain('knowledgeRefreshStartedRef');
    expect(appContext).toContain('void refreshSessionKnowledge()');
  });
});
