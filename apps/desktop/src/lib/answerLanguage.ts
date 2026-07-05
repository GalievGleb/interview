/**
 * Язык ответов ИИ (live-подсказки, ручной вопрос, «Экран»).
 * 'auto' — модель отвечает на языке вопроса (поведение по умолчанию).
 */

export type AnswerLanguagePref = 'auto' | 'ru' | 'en';

const STORAGE_KEY = 'skillcue.answerLanguage';

export const ANSWER_LANGUAGE_LABELS: Record<AnswerLanguagePref, string> = {
  auto: 'Авто (как вопрос)',
  ru: 'Русский',
  en: 'Английский',
};

export function loadAnswerLanguage(): AnswerLanguagePref {
  if (typeof localStorage === 'undefined') return 'auto';
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'ru' || raw === 'en' ? raw : 'auto';
}

export function saveAnswerLanguage(pref: AnswerLanguagePref): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, pref);
}

/** Значение для поля answer_language в API: null — «авто». */
export function answerLanguageParam(): string | null {
  const pref = loadAnswerLanguage();
  return pref === 'auto' ? null : pref;
}
