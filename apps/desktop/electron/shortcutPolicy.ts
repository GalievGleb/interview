export const CANDIDATE_FOLLOW_UP_ACCELERATOR = 'CommandOrControl+\\';
export const SIDEBAR_TOGGLE_ACCELERATOR = 'Control+B';

export const PRODUCT_ACCELERATOR_INVENTORY = [
  { action: 'force-answer', accelerator: 'CommandOrControl+Enter' },
  { action: 'force-screen-answer', accelerator: 'CommandOrControl+Shift+Enter' },
  { action: 'candidate-follow-up', accelerator: CANDIDATE_FOLLOW_UP_ACCELERATOR },
  { action: 'sidebar-toggle', accelerator: SIDEBAR_TOGGLE_ACCELERATOR },
] as const;

const RESERVED_OVERLAY_SHORTCUTS = new Set([
  'commandorcontrol+enter',
  'ctrl+enter',
  'control+enter',
  'command+enter',
  'cmd+enter',
  'commandorcontrol+shift+enter',
  'ctrl+shift+enter',
  'control+shift+enter',
  'command+shift+enter',
  'cmd+shift+enter',
  'commandorcontrol+\\',
  'ctrl+\\',
  'control+\\',
  'command+\\',
  'cmd+\\',
]);

export function isReservedOverlayShortcut(shortcut: string): boolean {
  return RESERVED_OVERLAY_SHORTCUTS.has(shortcut.replace(/\s+/g, '').toLowerCase());
}
