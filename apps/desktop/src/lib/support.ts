/** Контакты поддержки SkillCue. Обновите перед релизом, если каналы изменятся. */

export const SUPPORT_TELEGRAM_URL = 'https://t.me/SkillCue';

/** Открывает внешнюю ссылку через main-процесс (fallback — window.open в браузере). */
export function openSupportLink(url: string): void {
  if (window.electronAPI) void window.electronAPI.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
