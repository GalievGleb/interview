import { useSyncExternalStore } from 'react';

/**
 * Тема оформления: тёмная (по умолчанию), светлая или системная.
 * Палитра целиком живёт в CSS-переменных (tokens.css + workspace.css),
 * поэтому смена темы — это только атрибут data-theme на <html>.
 * Оверлей всегда тёмный: он плавает над рабочим столом (см. OverlayPage).
 */

export type ThemePref = 'system' | 'dark' | 'light';

const THEME_KEY = 'skillcue.theme';

const listeners = new Set<() => void>();
let current: ThemePref = 'dark';

const media =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null;

function resolved(pref: ThemePref): 'dark' | 'light' {
  if (pref === 'system') return media?.matches ? 'light' : 'dark';
  return pref;
}

function apply(): void {
  document.documentElement.dataset.theme = resolved(current);
}

/** Вызывается один раз при старте приложения (main.tsx). */
export function initTheme(): void {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light' || saved === 'system') current = saved;
  apply();
  media?.addEventListener('change', () => {
    if (current === 'system') apply();
    listeners.forEach((l) => l());
  });
  // Синхронизация между окнами (настройки в главном, оверлей отдельно).
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY) return;
    const v = e.newValue;
    if (v === 'dark' || v === 'light' || v === 'system') {
      current = v;
      apply();
      listeners.forEach((l) => l());
    }
  });
}

export function getThemePref(): ThemePref {
  return current;
}

export function setThemePref(pref: ThemePref): void {
  current = pref;
  localStorage.setItem(THEME_KEY, pref);
  apply();
  listeners.forEach((l) => l());
}

/** Принудительно тёмная тема для окна оверлея (игнорирует предпочтение). */
export function forceDarkTheme(): void {
  document.documentElement.dataset.theme = 'dark';
}

export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void } {
  const pref = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
  return { pref, setPref: setThemePref };
}
