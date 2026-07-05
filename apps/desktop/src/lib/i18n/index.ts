/**
 * Лёгкий i18n без зависимостей: типизированные ключи (источник — ru.ts),
 * словари ru/en, `t()` для не-React кода и `useI18n()` для компонентов
 * (re-render через useSyncExternalStore при смене языка).
 *
 * Конвертация приложения — инкрементальная: новые/переведённые экраны берут
 * useI18n, остальные остаются на захардкоженном русском до своей очереди.
 */
import { useSyncExternalStore } from 'react';
import { en } from './en';
import { ru, type I18nKey } from './ru';

export type { I18nKey };
export type Lang = 'ru' | 'en';

const STORAGE_KEY = 'skillcue.lang';
const DICTS: Record<Lang, Record<I18nKey, string>> = { ru, en };

let current: Lang = (() => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'en' ? 'en' : 'ru';
  } catch {
    return 'ru';
  }
})();

const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((fn) => fn());
}

export function t(key: I18nKey): string {
  return DICTS[current][key] ?? ru[key] ?? key;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React-хук: `const { t, lang, setLang } = useI18n()` — ререндер при смене языка. */
export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getLang, getLang);
  return { t, lang, setLang };
}
