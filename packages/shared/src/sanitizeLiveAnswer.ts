const DIAGNOSTIC_PREFIX_RES: RegExp[] = [
  /^Похоже,\s*вопрос\s*(?:про|о|об)\s*[^.?!]*[.?!]\s*/iu,
  /^Похоже,\s*вопрос\s*[^.?!]*[.?!]\s*/iu,
  /^Похоже,\s*[^.?!]*[.?!]\s*/iu,
  /^Вероятно,\s*вопрос\s*(?:про|о|об)\s*[^.?!]*[.?!]\s*/iu,
  /^Вероятно,\s*[^.?!]*[.?!]\s*/iu,
  /^Судя\s+по\s+всему,\s*[^.?!]*[.?!]\s*/iu,
  /^Я\s+понял\s+вопрос\s+как\s*[^.?!]*[.?!]\s*/iu,
  /^Если\s+вопрос\s*(?:про|о|об)\s*[^.?!]*[.?!]\s*/iu,
  /^Вопрос\s+касается\s*[^.?!]*[.?!]\s*/iu,
];

const CALL_CENTER_PHRASE_RES: RegExp[] = [
  /Если у вас есть другие вопросы[^.?!]*[.?!]\s*/giu,
  /Можете уточнить[^.?!]*[.?!]\s*/giu,
  /Извините,\s*я не совсем понял[^.?!]*[.?!]\s*/giu,
  /С радостью отвечу[^.?!]*[.?!]\s*/giu,
];

// "Если хотите, могу подробнее рассказать/разложить…" and similar ChatGPT
// offers-to-continue. Anchored so they only match a trailing closing sentence.
const CHATGPT_TAIL_RES: RegExp[] = [
  /(?:^|\s)Если\s+(?:хотите|хочешь|нужно|интересно)[^.?!]*(?:рассказ\w*|разлож\w*|расскаж\w*|подробн\w*|объясн\w*|пример\w*)[^.?!]*[.?!]\s*$/giu,
  /(?:^|\s)Могу\s+(?:также\s+)?(?:подробнее|ещё|еще|дополнительно)[^.?!]*[.?!]\s*$/giu,
  /(?:^|\s)Хотите,\s+(?:я\s+)?(?:расскаж\w*|разлож\w*|покаж\w*)[^.?!]*[.?!]\s*$/giu,
];

// Whole filler sentences with no information — remove wherever they appear.
const FILLER_SENTENCE_RES: RegExp[] = [
  /(?:^|\s)В\s+разных\s+контекстах\s+могут\s+быть\s+разные\s+подходы[^.?!]*[.?!]\s*/giu,
  /(?:^|\s)Это\s+позволило\s+мне\s+углубить\s+(?:свои\s+)?знания[^.?!]*[.?!]\s*/giu,
  /(?:^|\s)Существуют\s+различные\s+инструменты\s+и\s+методы[^.?!]*[.?!]\s*/giu,
];

// Filler openers — strip the opener, keep the sentence body that follows.
const FILLER_OPENER_RES: RegExp[] = [
  /(?:^|(?<=[.?!]\s))(?:Важно\s+отметить|Стоит\s+отметить|Хочу\s+отметить),?\s*(?:что\s+)?/giu,
  /(?:^|(?<=[.?!]\s))В\s+заключение,?\s*/giu,
  /(?:^|(?<=[.?!]\s))Давайте\s+рассмотрим,?\s*/giu,
];

// Internal section labels the model sometimes leaks (incl. as markdown headers).
const LABELS =
  'Main\\s+answer|Short\\s+answer|Key\\s+points?|Detailed|Risks?|' +
  'Краткий\\s+ответ|Основной\\s+ответ|Ключевые\\s+(?:моменты|пункты)';
const INTERNAL_LABEL_RES: RegExp[] = [
  // A label alone on its own line (optional #/** wrappers, optional colon).
  new RegExp(`(?:^|\\n)[ \\t]*#{0,6}[ \\t]*\\*{0,2}[ \\t]*(?:${LABELS})[ \\t]*\\*{0,2}[ \\t]*:?[ \\t]*(?=\\n|$)`, 'giu'),
  // Label at the start of a line with inline content after a colon.
  new RegExp(`(?:^|\\n)[ \\t]*\\*{0,2}[ \\t]*(?:${LABELS})[ \\t]*\\*{0,2}[ \\t]*:[ \\t]*`, 'giu'),
  // Label inline after sentence punctuation, with a colon.
  new RegExp(`(?<=[.?!])[ \\t]*\\*{0,2}[ \\t]*(?:${LABELS})[ \\t]*\\*{0,2}[ \\t]*:[ \\t]*`, 'giu'),
  // Any remaining markdown header markers -> drop the # but keep the heading text.
  /(?:^|\n)[ \t]*#{1,6}[ \t]*/g,
];

function stripPatterns(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const re of patterns) out = out.replace(re, ' ');
  return out;
}

/**
 * Удаляет диагностические вводные, внутренние заголовки (Main answer / Key
 * points), ChatGPT-хвосты («Если хотите, могу подробнее…») и пустые филлеры из
 * live-ответа перед показом пользователю. Технические термины и короткие
 * списки не трогает. Safe to run on streaming partials (idempotent).
 */
export function sanitizeLiveAnswer(answer: string): string {
  let text = answer.trim();
  if (!text) return text;

  text = stripPatterns(text, INTERNAL_LABEL_RES);
  text = stripPatterns(text, FILLER_OPENER_RES);

  let changed = true;
  while (changed) {
    changed = false;
    for (const re of [
      ...DIAGNOSTIC_PREFIX_RES,
      ...CALL_CENTER_PHRASE_RES,
      ...CHATGPT_TAIL_RES,
      ...FILLER_SENTENCE_RES,
    ]) {
      const next = text.replace(re, ' ').trim();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }
  // Collapse the whitespace the removals leave behind, keeping line breaks.
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Enforce the Say-aloud length budget: trim to the last complete sentence that
 * keeps the answer at/under `maxWords`. Lists and terms are preserved; we only
 * cut at sentence boundaries so the result still reads naturally aloud.
 */
export function trimSpokenAnswer(answer: string, maxWords = 90): string {
  const text = (answer || '').trim();
  if (!text) return text;
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;

  // Split into sentences (keep the terminator), accumulate until the cap.
  const sentences = text.match(/[^.?!\n]+[.?!]?(?:\n+|$|\s)/g) ?? [text];
  let acc = '';
  let count = 0;
  for (const s of sentences) {
    const w = s.trim().split(/\s+/).filter(Boolean).length;
    if (count + w > maxWords) break;
    acc += s;
    count += w;
  }
  acc = acc.trim();
  // If even the first sentence blows the budget, hard-cut on a word boundary.
  if (!acc) return words.slice(0, maxWords).join(' ').replace(/[\s,;:–-]+$/, '') + '…';
  return acc;
}
