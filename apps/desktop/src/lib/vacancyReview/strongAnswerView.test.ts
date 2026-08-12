import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('practice strong-answer surface', () => {
  it('shows the finished answer for both AI and local evaluations', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../components/prepare/SmokeInterviewView.tsx'),
      'utf8',
    );

    expect(source).toContain('{evaluation.suggestedBetterAnswer && (');
    expect(source).not.toContain(
      "evaluation.suggestedBetterAnswer && evaluation.evaluationSource !== 'heuristic'",
    );
  });
});
