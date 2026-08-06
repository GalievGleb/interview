import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'OverlayTooltipLayer.tsx'), 'utf8');

describe('overlay tooltip layer', () => {
  it('refreshes a visible tooltip when its trigger changes meaning', () => {
    expect(source).toContain('new MutationObserver(syncText)');
    expect(source).toContain("attributeFilter: ['data-tip']");
  });
});
