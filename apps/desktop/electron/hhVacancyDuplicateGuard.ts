export interface HhDuplicateGuardVacancy {
  key: string;
  id: string;
  platform: string;
  company: string;
  description?: string;
  status: string;
  coverLetterPending?: boolean;
}

const MIN_DESCRIPTION_CHARACTERS = 160;
const MIN_DESCRIPTION_WORDS = 20;
const RESERVED_STATUSES = new Set(['new', 'opened', 'prepared', 'needs_input']);

function normalizeFingerprintText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFingerprintGradeDescription(value: string): boolean {
  const normalized = normalizeFingerprintText(value);
  return normalized.length >= MIN_DESCRIPTION_CHARACTERS
    && normalized.split(' ').filter(Boolean).length >= MIN_DESCRIPTION_WORDS;
}

/**
 * Search result cards frequently return an empty or abbreviated description.
 * Do not let that erase a full description captured on the vacancy page,
 * because the latter is also the durable duplicate-response fingerprint.
 */
export function mergeHhVacancyDescription(
  existingDescription: string | undefined,
  scannedDescription: string | undefined,
): string {
  const existing = String(existingDescription ?? '').trim();
  const scanned = String(scannedDescription ?? '').trim();
  if (isFingerprintGradeDescription(scanned)) return scanned;
  if (isFingerprintGradeDescription(existing)) return existing;
  return scanned || existing;
}

/**
 * Builds a deliberately strict content fingerprint. The title is not part of
 * the key: identical vacancy text from the same employer is treated as one
 * posting even when HH assigns another id or slightly changes the title.
 * Conversely, equal company/title pairs with different descriptions are kept
 * separate.
 */
export function hhVacancyDuplicateFingerprint(
  vacancy: Pick<HhDuplicateGuardVacancy, 'platform' | 'company' | 'description'>,
): string | null {
  if (vacancy.platform !== 'hh') return null;
  const company = normalizeFingerprintText(vacancy.company);
  const description = normalizeFingerprintText(vacancy.description ?? '');
  if (!company || !isFingerprintGradeDescription(description)) return null;
  return `${company}\n${description}`;
}

/**
 * Finds a vacancy that already owns this employer+description fingerprint.
 * A confirmed/accepted response always wins. Among unfinished queue entries,
 * only an earlier item reserves the fingerprint, which makes queue processing
 * deterministic without collapsing distinct descriptions.
 */
export function findHhSemanticDuplicate<T extends HhDuplicateGuardVacancy>(
  queue: readonly T[],
  vacancy: T,
  capturedDescription: string,
): T | null {
  const fingerprint = hhVacancyDuplicateFingerprint({
    ...vacancy,
    description: capturedDescription,
  });
  if (!fingerprint) return null;

  const currentIndex = queue.findIndex((item) => item.key === vacancy.key);
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (candidate.key === vacancy.key || candidate.platform !== 'hh') continue;
    if (hhVacancyDuplicateFingerprint(candidate) !== fingerprint) continue;

    const responseAlreadyExists = candidate.status === 'sent'
      || candidate.status === 'already_applied'
      || Boolean(candidate.coverLetterPending);
    const earlierItemOwnsAttempt = currentIndex >= 0
      && index < currentIndex
      && RESERVED_STATUSES.has(candidate.status);
    if (responseAlreadyExists || earlierItemOwnsAttempt) return candidate;
  }
  return null;
}
