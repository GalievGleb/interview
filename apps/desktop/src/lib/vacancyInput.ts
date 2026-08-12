const HH_VACANCY_URL_PATTERN = /https?:\/\/(?:[a-z0-9-]+\.)?hh\.ru\/vacancy\/\d+[^\s]*/i;
const STANDALONE_HH_VACANCY_URL_PATTERN = /^https?:\/\/(?:[a-z0-9-]+\.)?hh\.ru\/vacancy\/\d+(?:[/?#][^\s]*)?$/i;

export function hhVacancyUrlFromInput(value: string): string {
  const candidate = value.match(HH_VACANCY_URL_PATTERN)?.[0]?.replace(/[),.;]+$/, '');
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    const id = url.pathname.match(/^\/vacancy\/(\d+)/)?.[1];
    return id ? `https://hh.ru/vacancy/${id}` : '';
  } catch {
    return '';
  }
}

/**
 * Returns a vacancy URL only when the entire value is a URL. A Telegram message
 * that happens to contain an HH link must remain regular editable text.
 */
export function hhVacancyUrlFromStandaloneInput(value: string): string {
  const trimmed = value.trim();
  if (!STANDALONE_HH_VACANCY_URL_PATTERN.test(trimmed)) return '';
  return hhVacancyUrlFromInput(trimmed);
}

export function mergeVacancyWithAdditionalContext(importedText: string, additionalText: string): string {
  const imported = importedText.trim();
  const additional = additionalText.trim();
  if (!additional) return imported;
  if (!imported) return additional;
  if (additional === imported || additional.includes(imported)) return additional;
  if (imported.includes(additional)) return imported;
  return `${imported}\n\nДополнительный контекст от HR:\n${additional}`;
}
