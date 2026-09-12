import type { BuildChannel } from './buildChannel';

export function describeUpdateError(error: unknown): string {
  // Classify locally, but never reflect request URLs, tokens or raw exceptions.
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/iu.test(message)) {
    return 'Не удалось определить адрес сервера обновлений (DNS). Проверьте подключение и повторите проверку. При необходимости установите обновление с официального сайта SkillCue.';
  }
  if (/TIMED?_?OUT|ETIMEDOUT|ERR_CONNECTION|ECONNRESET|ECONNREFUSED|ERR_INTERNET_DISCONNECTED/iu.test(message)) {
    return 'Сервер обновлений недоступен или истекло время ожидания. Проверьте подключение и повторите попытку.';
  }
  if (/checksum|sha512|sha256|signature|ERR_UPDATER_INVALID/iu.test(message)) {
    return 'Файл обновления повреждён или не прошёл проверку подлинности. Не запускайте его; скачайте обновление заново с официального сайта SkillCue.';
  }
  if (/\b404\b|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|Cannot find.*latest/iu.test(message)) {
    return 'Файл обновления пока недоступен. Повторите проверку позже или скачайте установщик с официального сайта SkillCue.';
  }
  return 'Не удалось проверить или установить обновление. Повторите попытку позже; текущей версией можно продолжать пользоваться.';
}

export function unsupportedUpdateMessage(channel: BuildChannel): string {
  if (channel === 'alpha') {
    return 'SkillCue Alpha: автоматическое обновление не подключено. Используйте отдельный установщик Alpha; обычный релиз с сайта обновляет только Stable.';
  }
  if (channel === 'dev') {
    return 'SkillCue Dev: используйте отдельный установщик Dev. Публичные обновления Stable сюда не устанавливаются.';
  }
  return 'Обновления macOS пока устанавливаются новой версией с официального сайта SkillCue.';
}
