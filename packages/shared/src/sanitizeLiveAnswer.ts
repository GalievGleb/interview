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

/** Удаляет диагностические вводные из live-ответа перед показом пользователю. */
export function sanitizeLiveAnswer(answer: string): string {
  let text = answer.trim();
  if (!text) return text;

  let changed = true;
  while (changed) {
    changed = false;
    for (const re of [...DIAGNOSTIC_PREFIX_RES, ...CALL_CENTER_PHRASE_RES]) {
      const next = text.replace(re, '').trimStart();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }
  return text.trim();
}
