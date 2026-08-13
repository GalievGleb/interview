const WORK_MODE_PREFIX = /^(?:постоянная работа(?:\s*,\s*подработка)?|подработка)\s+/i;
const REMOTE_SUFFIX = /\s*[·•]\s*удал[её]нно\s*$/i;

/**
 * HH sometimes prefixes a résumé title with employment modes. That metadata
 * is useful on the résumé page, but turns every vacancy row into a paragraph.
 * Keep only the role and salary — the information needed to verify which
 * résumé will be used for the response.
 */
export function compactHhResumeTitle(value: string): string {
  return value
    .replace(WORK_MODE_PREFIX, '')
    .replace(REMOTE_SUFFIX, '')
    .replace(/^qa\b/i, 'QA')
    .replace(/\s+/g, ' ')
    .trim();
}
