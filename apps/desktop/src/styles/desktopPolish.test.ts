import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const main = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
const titleBarTheme = fs.readFileSync(
  path.resolve(__dirname, '../../electron/titleBarTheme.ts'),
  'utf8',
);
const indexCss = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
const prepareCss = fs.readFileSync(path.resolve(__dirname, 'prepare.css'), 'utf8');
const cockpitCss = fs.readFileSync(path.resolve(__dirname, 'interview-cockpit.css'), 'utf8');
const overlayCss = fs.readFileSync(path.resolve(__dirname, 'overlay-cockpit.css'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/Sidebar.tsx'), 'utf8');
const home = fs.readFileSync(path.resolve(__dirname, '../pages/HomePage.tsx'), 'utf8');

describe('desktop polish contracts', () => {
  it('keeps native and CSS title bars at 44px so title-bar hover stays bounded', () => {
    expect(main).toContain("getTitleBarOverlayTheme('dark')");
    expect(titleBarTheme).toContain('height: 44');
    expect(indexCss).toContain('@apply flex h-11');
  });

  it('uses neutral indigo focus for ordinary form controls', () => {
    expect(indexCss).toContain('.field:focus,');
    expect(indexCss).toContain('.select-compact:focus');
    expect(indexCss).toContain('border-color: rgba(99, 102, 241, 0.62)');
    expect(indexCss).not.toContain('focus:border-accent focus:ring-2 focus:ring-accent-ring');
    expect(prepareCss).not.toContain('border-color: rgba(52, 199, 123, 0.55)');
    expect(cockpitCss).not.toContain('focus-within:border-accent/50');
  });

  it('removes only the ready label from the sidebar footer', () => {
    expect(sidebar).not.toContain("t('sidebar.ready')");
    expect(sidebar).toContain("t('sidebar.unavailable')");
    expect(sidebar).toContain('skillcue-sidebar__icon-button');
  });

  it('keeps the overlay input stable and neutral while it is focused', () => {
    expect(overlayCss).not.toContain('.ovl-input-wrap:focus-within');
    expect(overlayCss).not.toContain('.ovl-input:focus {');
    expect(overlayCss).not.toContain('transition: height');
    expect(overlayCss).toContain('.ovl-input:focus-visible');
    expect(overlayCss).toContain('outline: none');
  });

  it('gives the home context rail enough room to explain missing preparation', () => {
    expect(prepareCss).toContain(
      'grid-template-columns: minmax(0, 1fr) minmax(360px, 0.68fr)',
    );
    expect(prepareCss).toMatch(/\.prep-context-row\s*\{[^}]*min-height:\s*72px/s);
    expect(home).not.toContain('className="line-clamp-2"');
  });

  it('keeps the first preparation navigation item clear of the title bar edge', () => {
    expect(sidebar).toContain('overflow-y-auto px-2.5 py-1');
  });
});
