import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./prepare.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('history split-view containment', () => {
  it('keeps long session rows inside the left grid track', () => {
    expect(rule('.prep-history-grid')).toMatch(/min-width\s*:\s*0\s*;/);
    expect(rule('.prep-history-grid')).toMatch(
      /grid-template-columns\s*:\s*minmax\(300px,\s*380px\)\s+minmax\(0,\s*1fr\)\s*;/,
    );
    expect(rule('.prep-session-list')).toMatch(/min-width\s*:\s*0\s*;/);
    expect(rule('.prep-session-row')).toMatch(/min-width\s*:\s*0\s*;/);
    expect(rule('.prep-session-open')).toMatch(/min-width\s*:\s*0\s*;/);
    expect(rule('.prep-session-open')).toMatch(/max-width\s*:\s*100%\s*;/);
  });

  it('allows the detail panel to shrink within the right grid track', () => {
    expect(rule('.prep-session-detail')).toMatch(/min-width\s*:\s*0\s*;/);
  });

  it('stacks the history panes below the desktop breakpoint', () => {
    expect(css).toMatch(
      /@media\s*\(max-width:\s*1050px\)[\s\S]*?\.prep-history-grid\s*\{[^}]*grid-template-columns\s*:\s*1fr\s*;/,
    );
  });
});
