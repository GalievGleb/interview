export interface HhCoverLetterRequest {
  vacancyTitle: string;
  vacancyCompany: string;
  vacancyDescription: string;
  language: 'ru' | 'en';
}

export interface HhCoverLetterMatch {
  vacancyNeed: string;
  resumeEvidence: string;
}

export interface HhCoverLetterResponse {
  coverLetter: string;
  matches: HhCoverLetterMatch[];
  canAutoFill: boolean;
  reason?: string;
  model?: string;
}

export interface ValidatedHhCoverLetter {
  letter: string;
  matches: HhCoverLetterMatch[];
}

const PLACEHOLDER_PATTERN = /\{[^{}]{1,80}\}|\[(?:встав|укаж|имя|назван|пример|метрик)[^\]]*\]/iu;
const MARKDOWN_LIST_PATTERN = /^(?:\s*[-*]\s+|\s*\d+[.)]\s+)/mu;

/**
 * Reject weak or unfinished model output before it reaches the HH form. The
 * backend performs the same checks; this is the final desktop-side guard.
 */
export function validateGeneratedHhCoverLetter(
  response: HhCoverLetterResponse,
): ValidatedHhCoverLetter | null {
  if (!response.canAutoFill || !Array.isArray(response.matches) || response.matches.length < 2) {
    return null;
  }
  const letter = String(response.coverLetter ?? '').replace(/\r\n/g, '\n').trim();
  if (letter.length < 350 || letter.length > 4_000) return null;
  if (!/^(?:Здравствуйте!|Hello[!,])/iu.test(letter)) return null;
  if (PLACEHOLDER_PATTERN.test(letter) || MARKDOWN_LIST_PATTERN.test(letter)) return null;

  const matches = response.matches
    .filter((item) => item && item.vacancyNeed?.trim() && item.resumeEvidence?.trim())
    .slice(0, 5)
    .map((item) => ({
      vacancyNeed: item.vacancyNeed.trim().slice(0, 300),
      resumeEvidence: item.resumeEvidence.trim().slice(0, 500),
    }));
  if (matches.length < 2) return null;
  return { letter, matches };
}
