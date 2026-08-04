import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const supportSource = readFileSync(fileURLToPath(new URL('./support.ts', import.meta.url)), 'utf8');
const settingsSource = readFileSync(
  fileURLToPath(new URL('../pages/SettingsPage.tsx', import.meta.url)),
  'utf8',
);

describe('public support channel', () => {
  it('uses @SkillCue without exposing an inactive support email', () => {
    expect(supportSource).toContain("https://t.me/SkillCue");
    expect(supportSource).not.toContain('SUPPORT_EMAIL');
    expect(settingsSource).not.toContain('mailto:');
    expect(settingsSource).toContain('?text=');
  });
});
