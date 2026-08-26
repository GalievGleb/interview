const RUSSIAN_VISUAL_REFERENCE =
  /(?:эт(?:от|а|о|и|ого|ой|их)\s+(?:код\w*|фрагмент\w*|пример\w*|выражени\w*|задани\w*|задач\w*|таблиц\w*|схем\w*|скриншот\w*)|решени\w*\s+(?:этого|этой|данного|данной)\s+(?:задани\w*|задач\w*)|рашэнн[а-яёіў]*\s+г?этаг[а-яёіў]*\s+задач[а-яёіў]*|реш(?:и|ите)\s+(?:его|е[её])(?:\b|[.!?])|решив[оа](?:\b|[.!?])|перед\s+(?:тобой|вами)(?:\s+(?:сейчас|находится|открыто|видно|есть))*\s+(?:задани\w*|задач\w*|код\w*|пример\w*)|на\s+(?:этом\s+)?(?:экране|экран|скриншоте|скриншот)|в\s+(?:этом\s+)?редакторе|что\s+(?:выведет|верн[её]т|произойд[её]т)\s+(?:этот|данный)?\s*(?:код|фрагмент|выражени\w*)?|в\s+како(?:м|й)\s+(?:порядк\w*|последовательност\w*)[^?!.\n]{0,100}(?:фикстур\w*|текстур\w*))/iu;

const ENGLISH_VISUAL_REFERENCE =
  /(?:this\s+(?:code|snippet|example|expression|task|table|diagram|screenshot)|on\s+(?:this\s+|the\s+)?screen|in\s+(?:this\s+|the\s+)?editor|what\s+(?:does|will)\s+(?:this\s+)?(?:code|snippet|expression)\s+(?:print|output|return|do))/iu;

const RUSSIAN_EXPLICIT_VISIBLE_TASK =
  /(?:проанализир[а-яё]*\s+(?:этот\s+|данный\s+)?код[а-яё]*|услови[а-яё]*(?:\s+описани[а-яё]*)?\s+задач[а-яё]*|(?:на\s+(?:экране|скриншоте)|в\s+(?:этом\s+)?редакторе)[^?!\n]{0,100}(?:код[а-яё]*|задач[а-яё]*|задани[а-яё]*|пример[а-яё]*)|перед\s+(?:тобой|вами)[^?!\n]{0,100}(?:код[а-яё]*|задач[а-яё]*|задани[а-яё]*)|(?:виден|видно|показан[а-яё]*)[^?!\n]{0,100}(?:код[а-яё]*|задач[а-яё]*|задани[а-яё]*|пример[а-яё]*))/iu;

const RUSSIAN_VISIBLE_TASK_OUTPUT =
  /(?:очередност[а-яё]*|порядок[а-яё]*|последовательност[а-яё]*|ассерт[а-яё]*|результат[а-яё]*|что\s+проверяем|что\s+(?:получится|верн[её]тся|выведется|будет))/iu;

const RUSSIAN_CONCEPTUAL_FIXTURE_ORDER =
  /(?:^|[^\p{L}\p{N}])в\s+како[мй]\s+(?:порядк[а-яё]*|последовательност[а-яё]*)[^?!.]{0,120}(?:pytest[-\s]*)?(?:фикстур[а-яё]*|текстур[а-яё]*)/iu;

const RUSSIAN_SCREEN_DEICTIC =
  /(?:(?:в\s+)?(?:эт(?:от|а|о|и|ого|ом|ой|их)|данн(?:ом|ой))\s+(?:код[а-яё]*|задани[а-яё]*|задач[а-яё]*|фрагмент[а-яё]*|пример[а-яё]*)|на\s+(?:этом\s+)?(?:экране|скриншоте)|в\s+(?:этом\s+)?редакторе|перед\s+(?:тобой|вами))/iu;

/**
 * True when the spoken transcript explicitly points to information that only
 * exists on screen. Ctrl+Enter must then use the vision route even though STT
 * produced a non-empty final; otherwise prompts such as «что выведет этот код»
 * reach the text model without the code itself.
 */
export function requiresScreenContext(question: string): boolean {
  const normalized = question.trim();
  if (!normalized) return false;
  if (
    RUSSIAN_CONCEPTUAL_FIXTURE_ORDER.test(normalized) &&
    !RUSSIAN_SCREEN_DEICTIC.test(normalized)
  ) {
    return false;
  }
  return (
    RUSSIAN_VISUAL_REFERENCE.test(normalized) ||
    ENGLISH_VISUAL_REFERENCE.test(normalized) ||
    (RUSSIAN_EXPLICIT_VISIBLE_TASK.test(normalized) &&
      RUSSIAN_VISIBLE_TASK_OUTPUT.test(normalized))
  );
}
