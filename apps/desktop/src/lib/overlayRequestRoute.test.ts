import { describe, expect, it } from 'vitest';
import { resolveOverlayRequestRoute } from './overlayRequestRoute';

describe('resolveOverlayRequestRoute', () => {
  it('answers a typed instruction as chat when there is no conversation', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'assist',
        customText: 'Что такое тестирование?',
        hasTranscript: false,
        canCaptureScreen: true,
        useScreenFallback: true,
        smart: false,
      }),
    ).toEqual({ kind: 'chat', mode: 'fast' });
  });

  it('keeps a non-visual Smart instruction on the deep text route', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'assist',
        customText: 'Сравни контрактные и интеграционные тесты',
        hasTranscript: false,
        canCaptureScreen: true,
        useScreenFallback: true,
        smart: true,
      }),
    ).toEqual({ kind: 'chat', mode: 'deep' });
  });

  it('uses vision for a typed question that explicitly refers to the visible screen', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'assist',
        customText: 'Что выведет этот код на экране?',
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

  it('does not turn an empty Assist request into a screenshot', () => {
    expect(
      resolveOverlayRequestRoute({
        action: 'assist',
        customText: '',
        hasTranscript: false,
        canCaptureScreen: true,
        useScreenFallback: true,
        smart: false,
      }),
    ).toEqual({ kind: 'notice' });
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
