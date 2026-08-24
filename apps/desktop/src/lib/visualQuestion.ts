const RUSSIAN_VISUAL_REFERENCE =
  /(?:эт(?:от|а|о|и)\s+(?:код|фрагмент|пример|выражени\w*|задани\w*|таблиц\w*|схем\w*|скриншот)|на\s+(?:этом\s+)?(?:экране|экран|скриншоте|скриншот)|в\s+(?:этом\s+)?редакторе|что\s+(?:выведет|верн[её]т|произойд[её]т)\s+(?:этот|данный)?\s*(?:код|фрагмент|выражени\w*)?)/iu;

const ENGLISH_VISUAL_REFERENCE =
  /(?:this\s+(?:code|snippet|example|expression|task|table|diagram|screenshot)|on\s+(?:this\s+|the\s+)?screen|in\s+(?:this\s+|the\s+)?editor|what\s+(?:does|will)\s+(?:this\s+)?(?:code|snippet|expression)\s+(?:print|output|return|do))/iu;

/**
 * True when the spoken transcript explicitly points to information that only
 * exists on screen. Ctrl+Enter must then use the vision route even though STT
 * produced a non-empty final; otherwise prompts such as «что выведет этот код»
 * reach the text model without the code itself.
 */
export function requiresScreenContext(question: string): boolean {
  const normalized = question.trim();
  if (!normalized) return false;
  return RUSSIAN_VISUAL_REFERENCE.test(normalized) || ENGLISH_VISUAL_REFERENCE.test(normalized);
}
