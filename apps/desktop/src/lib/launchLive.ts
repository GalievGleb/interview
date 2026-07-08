/**
 * Единая точка запуска live-режима. Раньше это была полноэкранная страница
 * /interview; теперь live — плавающий оверлей (окно Electron), поэтому «Запустить
 * live» просто показывает его. В обычном браузере (dev) окна оверлея нет —
 * открываем маршрут /overlay в текущем окне, чтобы виджет всё равно можно было
 * посмотреть и потестировать.
 */
export function launchLive(fallbackNavigate?: () => void): void {
  const overlay = window.electronAPI?.overlay;
  if (overlay?.show) {
    void overlay.show();
    return;
  }
  fallbackNavigate?.();
}
