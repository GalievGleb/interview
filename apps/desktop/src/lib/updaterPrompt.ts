import type { UpdaterStatus } from '../types/electron';

const UPDATE_BUTTON_STATES: ReadonlySet<UpdaterStatus['state']> = new Set([
  'available',
  'downloading',
  'ready',
  'waiting-for-session-end',
  'installing',
]);

/** Показывать кнопку «Обновить» справа, пока есть новая сборка. */
export function shouldShowUpdateButton(state: UpdaterStatus['state']): boolean {
  return UPDATE_BUTTON_STATES.has(state);
}
