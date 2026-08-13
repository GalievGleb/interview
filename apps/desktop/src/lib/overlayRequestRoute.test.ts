import { describe, expect, it } from 'vitest';
import { resolveOverlayRequestRoute } from './overlayRequestRoute';

describe('resolveOverlayRequestRoute', () => {
  it('keeps a typed instruction attached to the screen when there is no conversation', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'assist',
        customText: 'Что такое тестирование?',
        hasTranscript: false,
        canCaptureScreen: true,
        useScreenFallback: true,
        smart: false,
      }),
    ).toEqual({ kind: 'screen', mode: 'general' });
  });

  it('keeps Smart typed screen instructions on the deep vision route', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'assist',
        customText: 'Сравни контрактные и интеграционные тесты',
        hasTranscript: false,
        canCaptureScreen: true,
        useScreenFallback: true,
        smart: true,
      }),
    ).toEqual({ kind: 'screen', mode: 'deep' });
  });

  it('uses typed text with the live conversation when a transcript exists', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'assist',
        customText: 'Answer with the conversation context',
        hasTranscript: true,
        canCaptureScreen: true,
        useScreenFallback: true,
        smart: false,
      }),
    ).toEqual({ kind: 'chat', mode: 'fast' });
  });

  it('uses the screen only for an explicit screen action', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'screen',
        customText: 'Объясни этот код',
        hasTranscript: true,
        canCaptureScreen: true,
        useScreenFallback: false,
        smart: false,
      }),
    ).toEqual({ kind: 'screen', mode: 'general' });
  });

  it('keeps the configured empty Assist screen fallback', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'assist',
        customText: '',
        hasTranscript: false,
        canCaptureScreen: true,
        useScreenFallback: true,
        smart: false,
      }),
    ).toEqual({ kind: 'screen', mode: 'general' });
  });

  it('uses general text chat for transcript-backed actions', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'say',
        customText: '',
        hasTranscript: true,
        canCaptureScreen: true,
        useScreenFallback: true,
        smart: false,
      }),
    ).toEqual({ kind: 'chat', mode: 'general' });
  });

  it('returns notice when neither text, transcript, nor screen fallback is available', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'assist',
        customText: '',
        hasTranscript: false,
        canCaptureScreen: false,
        useScreenFallback: true,
        smart: false,
      }),
    ).toEqual({ kind: 'notice' });
  });
});
