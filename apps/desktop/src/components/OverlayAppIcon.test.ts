import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import OverlayAppIcon from './OverlayAppIcon';

describe('overlay app icon', () => {
  it('has native dimensions before styles load so the 512px asset cannot flash stretched', () => {
    const html = renderToStaticMarkup(React.createElement(OverlayAppIcon));

    expect(html).toContain('<img');
    expect(html).toContain('skillcue-app-icon-512.png');
    expect(html).not.toContain('>SC<');
    expect(html).toContain('width="26"');
    expect(html).toContain('height="26"');
  });
});
