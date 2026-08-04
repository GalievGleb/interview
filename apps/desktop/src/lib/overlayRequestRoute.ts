import type { ChatMode } from './aiModels';

export type OverlayActionId = 'assist' | 'say' | 'followup' | 'recap' | 'screen';

export interface OverlayRequestRouteInput {
  action: OverlayActionId;
  customText: string;
  hasTranscript: boolean;
  canCaptureScreen: boolean;
  useScreenFallback: boolean;
  smart: boolean;
}

export type OverlayRequestRoute =
  | { kind: 'chat'; mode: ChatMode }
  | { kind: 'screen'; mode: 'general' | 'deep' }
  | { kind: 'notice' };

export function resolveOverlayRequestRoute(
  input: OverlayRequestRouteInput,
): OverlayRequestRoute {
  if (input.action === 'screen') {
    return { kind: 'screen', mode: input.smart ? 'deep' : 'general' };
  }
  if (input.customText.trim()) {
    return { kind: 'chat', mode: input.smart ? 'deep' : 'fast' };
  }
  if (
    input.action === 'assist' &&
    !input.hasTranscript &&
    input.canCaptureScreen &&
    input.useScreenFallback
  ) {
    return { kind: 'screen', mode: input.smart ? 'deep' : 'general' };
  }
  if (!input.hasTranscript) return { kind: 'notice' };
  return { kind: 'chat', mode: input.smart ? 'deep' : 'general' };
}
