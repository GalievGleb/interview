import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import OverlayAppIcon from './OverlayAppIcon';

describe('OverlayAppIcon', () => {
  it('renders the real SkillCue icon instead of the SC placeholder', () => {
    const markup = renderToStaticMarkup(createElement(OverlayAppIcon));

    expect(markup).toContain('<img');
    expect(markup).toContain('skillcue-app-icon-512.png');
    expect(markup).not.toContain('>SC<');
  });
});
