import type { ChatMode } from './aiModels';
import { requiresScreenContext } from './visualQuestion';

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
  const customText = input.customText.trim();
  if (customText) {
    if (
      input.canCaptureScreen &&
      input.useScreenFallback &&
      requiresScreenContext(customText)
    ) {
      return { kind: 'screen', mode: input.smart ? 'deep' : 'general' };
    }
    return { kind: 'chat', mode: input.smart ? 'deep' : 'fast' };
  }
  if (!input.hasTranscript) return { kind: 'notice' };
  return { kind: 'chat', mode: input.smart ? 'deep' : 'general' };
}
