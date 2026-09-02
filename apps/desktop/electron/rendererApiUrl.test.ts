import { describe, expect, it } from 'vitest';
import { resolveRendererApiUrl } from './rendererApiUrl';

describe('renderer API URL', () => {
  it('matches the isolated developer backend in local and packaged dev builds', () => {
    expect(resolveRendererApiUrl('development')).toBe('http://127.0.0.1:8001');
    expect(resolveRendererApiUrl('devbuild')).toBe('http://127.0.0.1:8001');
  });

  it('uses the stable backend for production and tests', () => {
    expect(resolveRendererApiUrl('production')).toBe('http://127.0.0.1:8000');
    expect(resolveRendererApiUrl('test')).toBe('http://127.0.0.1:8000');
  });

  it('uses the isolated Alpha backend only for the Alpha renderer bundle', () => {
    expect(resolveRendererApiUrl('alphabuild')).toBe('http://127.0.0.1:8002');
  });

  it('honors an explicit build override without leaving a trailing slash', () => {
    expect(resolveRendererApiUrl('devbuild', ' http://localhost:9000/ ')).toBe(
      'http://localhost:9000',
    );
  });
});
