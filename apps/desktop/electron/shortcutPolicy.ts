const FORCE_ANSWER_SHORTCUTS = new Set([
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
]);

export function isReservedOverlayShortcut(shortcut: string): boolean {
  return FORCE_ANSWER_SHORTCUTS.has(shortcut.replace(/\s+/g, '').toLowerCase());
}
