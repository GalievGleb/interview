import { InterviewAnswer } from './api';

/** Текст подсказки для UI — без сырого JSON. */
export function getSuggestionText(answer: InterviewAnswer | null, prefer: 'spoken' | 'short' = 'spoken'): string {
  if (!answer) return '';

  const spoken = cleanText(answer.spoken);
  const short = cleanText(answer.short);

  if (prefer === 'spoken') return spoken || short;
  return short || spoken;
}

function cleanText(value: string | undefined): string {
  if (!value) return '';
  let text = value.trim();
  if (!text) return '';

  if (text.startsWith('{') || text.includes('"short"')) {
    try {
      const parsed = JSON.parse(text) as Record<string, string>;
      text = (parsed.spoken || parsed.short || '').trim();
    } catch {
      text = text
        .replace(/^\s*\{\s*"short"\s*:\s*"/, '')
        .replace(/"\s*,?\s*"spoken"\s*:\s*"/, ' ')
        .replace(/["'}]+$/, '')
        .trim();
    }
  }

  return text;
}
