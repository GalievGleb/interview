import type { HhQueueItem, HhScreeningQuestion } from '../types/electron';

export const HH_SCREENING_DRAFTS_STORAGE_KEY = 'skillcue.hhHrProfileDrafts.v1';

export interface HhScreeningLocalDraft {
  answer: string;
  selectedOptions: string[];
  confirmedByUser: boolean;
  /** Normalized employer prompt this draft was created for. */
  promptKey?: string;
}

const GENERIC_LOCAL_EXPERIENCE_DRAFT_RE =
  /^Подтверждённый релевантный опыт и инструменты перечислены в моём резюме;/i;

/**
 * The queue may contain a last-resort local sentence after a batched provider
 * call failed or omitted one item. It is safe to replace that sentence with a
 * single-question review draft as soon as the question becomes visible. A
 * useful model/user answer and every closed or sensitive factual fallback stay
 * untouched.
 */
export function shouldAutomaticallyPrepareHhScreeningDraft(
  question: HhScreeningQuestion,
  draft: HhScreeningLocalDraft | undefined,
): draft is HhScreeningLocalDraft {
  if (question.kind !== 'text' || !draft || draft.confirmedByUser) return false;
  if (draft.promptKey !== hhScreeningPromptKey(question.prompt)) return false;
  return GENERIC_LOCAL_EXPERIENCE_DRAFT_RE.test(draft.answer.trim());
}

export function isSensitiveHhScreeningChoice(prompt: string): boolean {
  return /гражданств|право\s+на\s+работ|разрешен\w*\s+на\s+работ|судим|военн|арм(?:ия|ии)|трудоустр|официальн|тк\s*рф|трудов\w*\s+(?:договор|опыт)|самозанят|\bип\b|\bгпх\b|зарплат|заработн\w*\s+плат|зарабатывать|получать|сумм|вознагражден|оклад|доход|компенсац|финансов\w*\s+ожидан|город|где.{0,25}жив|жив(?:е|ё)(?:те|шь)|место\s+(?:жительства|проживания)|прожива|локац|местонахожд|релокац|переезд|удален\w*\s+формат|график|смен|дата\s+выхода|за\s+последн|полгода|возраст|сколько\s+лет|дата\s+рожд|образован|диплом|сертифик|английск|уровень\s+язык|виз\w*|здоров|диагноз|инвалид|семейн|женат|замужем|дети|беремен|командиров|ночн\w*\s+(?:смен|работ)|\bnda\b|неразглаш|опыт|работал|использовал|пользовал|пользу(?:е|ё)т|знаком|применял|игр(?:а|ы|ал|али)|мессенджер|расскажите\s+о\s+себе|почему.*(?:ваканси|позици)|чем.*(?:ваканси|позици).*интерес|мотивац|experience|worked\s+with|used|current|currently|city|location|residen|work\s+(?:permit|authorization|status)|military|criminal|visa|health|education|certificate|english\s+level|travel|remote\s+(?:work|only)/i.test(prompt);
}

function isNeutralHhScreeningOption(option: string): boolean {
  return /^(?:по\s+договоренности|готов\w*\s+обсудить|свой\s+вариант|другое|иное|не\s+указан|нет\s+предпочтен|любой|any|other|not\s+specified)/i.test(option);
}

/**
 * Seeds the editor from persisted queue suggestions and upgrades unsafe v1
 * local drafts. Explicitly confirmed user input always wins. An unconfirmed
 * legal/status/history option from an old build has no provenance, so it is
 * replaced with an unselected review prompt (or an exact neutral option).
 */
export function reconcileHhScreeningLocalDraft(
  question: HhScreeningQuestion,
  current: HhScreeningLocalDraft | undefined,
): HhScreeningLocalDraft {
  const promptKey = hhScreeningPromptKey(question.prompt);
  // v1 drafts had no prompt fingerprint, so even an old confirmed flag cannot
  // prove that HH still shows the same employer question. Rebuild it once in
  // review mode; every new user edit is stamped with the current prompt below.
  if (current?.confirmedByUser === true && current.promptKey === promptKey) return current;
  const currentMatchesPrompt = current?.promptKey === promptKey;
  const sensitiveDraft = isSensitiveHhScreeningChoice(question.prompt);
  const currentUsable = question.kind === 'text'
    ? Boolean(current?.answer.trim())
    : Boolean(current?.selectedOptions.length || current?.answer.trim());
  if (current && currentMatchesPrompt && !sensitiveDraft && currentUsable) return current;

  const sensitiveClosed = question.kind !== 'text' && sensitiveDraft;
  const validSuggestedOptions = (question.suggestedOptions ?? []).filter(
    (option) => question.options.includes(option)
      && (!sensitiveClosed || isNeutralHhScreeningOption(option)),
  );
  const fallbackAnswer = question.kind === 'text'
    ? ''
    : sensitiveClosed
      ? 'Выберите точный вариант после проверки личного статуса или опыта: SkillCue не будет угадывать ответ «Да» или «Нет».'
      : 'Выберите подходящий вариант вручную: SkillCue не будет угадывать неподтверждённый ответ.';
  const next: HhScreeningLocalDraft = {
    answer: question.suggestedAnswer?.trim() || (validSuggestedOptions.length > 0 ? '' : fallbackAnswer),
    selectedOptions: validSuggestedOptions,
    confirmedByUser: false,
    promptKey,
  };
  if (
    current
    && current.answer === next.answer
    && current.selectedOptions.length === next.selectedOptions.length
    && current.selectedOptions.every((option, index) => option === next.selectedOptions[index])
    && current.confirmedByUser === next.confirmedByUser
    && current.promptKey === next.promptKey
  ) return current;
  return next;
}

export function readHhScreeningDrafts(
  storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): Record<string, HhScreeningLocalDraft> {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(HH_SCREENING_DRAFTS_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const result: Record<string, HhScreeningLocalDraft> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (!raw || typeof raw !== 'object') continue;
      const value = raw as Record<string, unknown>;
      result[key] = {
        answer: String(value.answer ?? '').slice(0, 2_000),
        selectedOptions: Array.isArray(value.selectedOptions)
          ? value.selectedOptions.map(String).slice(0, 30)
          : [],
        // Legacy and automatically generated drafts are intentionally not
        // treated as accepted until the user edits or explicitly uses them.
        confirmedByUser: value.confirmedByUser === true,
        promptKey: typeof value.promptKey === 'string'
          ? value.promptKey.slice(0, 1_200)
          : undefined,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function hhScreeningPromptKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9+#]+/gi, ' ')
    .trim();
}

const RELOCATION_RE = /релокац|переезд|переехать|перебраться|сменить\s+(?:город|место\s+жительства)/i;
const AGE_QUESTION_RE = /(?:сколько\s+(?:вам|тебе)\s+лет|(?:ваш[а-яё]*\s+)?возраст(?:\s+полных\s+лет)?)/i;
const DATE_OF_BIRTH_RE = /(?:дата|день|год)\s+рождени/i;
const BACKEND_FRONTEND_RATIO_RE = /(?=.*(?:б[эе]к(?:энд|енд)|backend))(?=.*(?:фронт(?:енд|энд)?|frontend))(?=.*(?:процент|соотношени|дол[яи]|\d{1,3}\s*%))/iu;
const REGIONAL_LOCATION_QUESTION_RE = /(?:регион|област|субъект(?:а)?\s*(?:рф|российск[а-яё]*\s+федерац)?|край|республик)/i;
const CURRENT_LOCATION_QUESTION_RE = /(?:где\s+(?:сейчас\s+)?(?:жив(?:е|ё)(?:те|шь)|прожива(?:е|ё)(?:те|шь)|находитесь)(?![а-яё])|в\s+как(?:ом|ой)\s+(?:городе|регионе|насел[её]нн[а-яё]*\s+пункте|локации)[^?\n]{0,35}(?:(?:вы|кандидат)[^?\n]{0,12})?(?:жив|прожив|находитесь|находится\s+кандидат)|где[^?\n]{0,35}(?:(?:вы|кандидат)[^?\n]{0,12})(?:жив|прожив|наход)|(?:укаж|назов|напиш)[^?\n]{0,25}(?:город|локац|насел[её]нн[а-яё]*\s+пункт)[^?\n]{0,30}(?:проживания|жительства|местонахождения)[\s?.:]*$|(?:укаж|назов|напиш)[а-яё]*[\s,:-]*(?:пожалуйста[\s,:-]*)?(?:(?:ваш[а-яё]*\s+)?(?:текущ[а-яё]*\s+)?(?:город|локац|насел[её]нн[а-яё]*\s+пункт)|место\s+(?:жительства|проживания)|местонахожд)[\s?.:]*$|(?:город|регион|насел[её]нн[а-яё]*\s+пункт)\s+(?:вашего\s+)?(?:фактическ[а-яё]*\s+)?(?:проживания|местонахождения)|(?:(?:ваш[а-яё]*\s+)?(?:текущ[а-яё]*|фактическ[а-яё]*)|ваш[а-яё]*)\s+(?:город|локац|место\s+(?:жительства|проживания)|местонахожд))/i;
const NON_CURRENT_LOCATION_QUESTION_RE = /(?:город|место|локац|насел[её]нн[а-яё]*\s+пункт).{0,50}(?:рождени|родн[а-яё]*|регистрац|пропис|офис|работодател|ваканси|компан|проект|команд|образован|обучен|работ|желаем|желательн|предпочитаем)|(?:рождени|родн[а-яё]*|регистрац|пропис|офис|работодател|ваканси|компан|проект|команд|образован|обучен|работ|желаем|желательн|предпочитаем).{0,50}(?:город|место|локац|насел[её]нн[а-яё]*\s+пункт)/i;
const FOREIGN_RELOCATION_RE = /за\s+(?:рубеж|границ)|другую\s+стран|саудов|оаэ|эмират|дуба[йе]|кипр|турц|грузи|тбилис|армени|ереван|казахстан|алмат|астан|кыргыз|бишкек|узбекистан|ташкент|серби|белград|черногор|европ|германи|польш|чехи|израил|сша|америк|канад|испан|португал|франц|итал|нидерланд|голланд|бельги|австри|швейцар|швец|норвег|финлянд|дани|великобритан|англи|ирланд|румын|болгар|венгр|хорват|словен|словац|литв|латви|эстон|грец|беларус|белорус|минск|украин|киев|молдов|кишинев|азербайджан|баку|мексик|бразил|аргентин|чили|австрали|нов(?:ую|ая)?\s+зеланд|индонез|таиланд|вьетнам/i;
const RUSSIAN_RELOCATION_RE = /(?:^|[^а-яё])(?:росси|рф(?=$|[^а-яё])|москв|санкт[ -]?петербург|петербург|питер|рязань|йошкар|казан|иннополис|новосибир|екатеринбург|нижн(?:ий|его)\s+новгород|самар|уф[ауе]|перм|омск|челябинск|ростов|краснодар|красноярск|воронеж|волгоград|соч[и]|тюмень|томск|саратов|тольятти|ижевск|барнаул|владивосток|хабаровск|калининград|ярославл|тула|иркутск|ульяновск)/i;

export type HhScreeningRelocationScope = 'russia' | 'abroad' | 'unspecified';

export function hhScreeningRelocationScope(value: string): HhScreeningRelocationScope | null {
  if (!RELOCATION_RE.test(value)) return null;
  if (FOREIGN_RELOCATION_RE.test(value)) return 'abroad';
  if (RUSSIAN_RELOCATION_RE.test(value)) return 'russia';
  return 'unspecified';
}

export function hhScreeningSemanticKey(value: string): string {
  if (AGE_QUESTION_RE.test(value) && !DATE_OF_BIRTH_RE.test(value)) {
    return 'profile:age';
  }
  if (BACKEND_FRONTEND_RATIO_RE.test(value)) {
    return 'profile:test-scope-ratio';
  }
  if (
    !RELOCATION_RE.test(value)
    && !REGIONAL_LOCATION_QUESTION_RE.test(value)
    && !NON_CURRENT_LOCATION_QUESTION_RE.test(value)
    && CURRENT_LOCATION_QUESTION_RE.test(value)
  ) {
    return 'profile:current-location';
  }
  // Distinct destinations must remain visible as distinct questions. A global
  // remote-only preference may still be reused by the Electron safety layer,
  // but UI dedupe must never hide a second city-specific question.
  return hhScreeningPromptKey(value);
}

export function uniqueHhScreeningQuestions(
  questions: HhScreeningQuestion[],
): HhScreeningQuestion[] {
  const unique = new Map<string, HhScreeningQuestion>();
  for (const question of questions) {
    const key = hhScreeningSemanticKey(question.prompt) || question.id;
    if (!unique.has(key)) unique.set(key, question);
  }
  return [...unique.values()];
}

export function isHhAiQuotaMessage(value: string | undefined): boolean {
  return /(?:месячн(?:ый|ого)?\s+лимит|лимит[^.]{0,50}(?:токен|тариф)|(?:token|monthly)\s+(?:quota|limit)|обновится\s+1-го)/i
    .test(value ?? '');
}

export function isHhScreeningAnswerComplete(
  question: Pick<HhScreeningQuestion, 'kind'>,
  answer: string | undefined,
  selectedOptions: string[] | undefined,
  confirmedByUser = false,
): boolean {
  if (!confirmedByUser) return false;
  return question.kind === 'text'
    ? Boolean(answer?.trim())
    : Boolean(selectedOptions?.length);
}

/**
 * A visible answer is ready when the user explicitly presses the final Send
 * action. That click is the confirmation; generated drafts must not require a
 * second, hidden "accept draft" step first.
 */
export function isHhScreeningDraftReady(
  question: Pick<HhScreeningQuestion, 'kind'>,
  answer: string | undefined,
  selectedOptions: string[] | undefined,
): boolean {
  return question.kind === 'text'
    ? Boolean(answer?.trim())
    : Boolean(selectedOptions?.length);
}

export interface HhPendingScreeningSummary {
  vacancies: HhQueueItem[];
  rawCount: number;
  uniqueCount: number;
  quotaLimitedCount: number;
  missingFactCount: number;
  uniqueQuestions: HhScreeningQuestion[];
}

export function summarizePendingHhScreening(queue: HhQueueItem[]): HhPendingScreeningSummary {
  const vacancies = queue.filter(
    (item) => item.platform === 'hh'
      && item.status === 'needs_input'
      && (item.pendingQuestions?.length ?? 0) > 0,
  );
  const unique = new Map<string, HhScreeningQuestion>();
  let rawCount = 0;
  for (const vacancy of vacancies) {
    for (const question of vacancy.pendingQuestions ?? []) {
      rawCount += 1;
      const key = hhScreeningSemanticKey(question.prompt) || question.id;
      if (!unique.has(key)) unique.set(key, question);
    }
  }
  const uniqueQuestions = [...unique.values()];
  const quotaLimitedCount = uniqueQuestions.filter(
    (question) => isHhAiQuotaMessage(question.assistantReason),
  ).length;
  return {
    vacancies,
    rawCount,
    uniqueCount: uniqueQuestions.length,
    quotaLimitedCount,
    missingFactCount: uniqueQuestions.length - quotaLimitedCount,
    uniqueQuestions,
  };
}

export function countUnansweredHhScreeningQuestions(
  summary: HhPendingScreeningSummary,
  drafts: Record<string, HhScreeningLocalDraft>,
): number {
  const answeredMeanings = new Set<string>();
  for (const vacancy of summary.vacancies) {
    for (const question of vacancy.pendingQuestions ?? []) {
      const draft = drafts[`${vacancy.key}::${question.id}`];
      if (draft?.promptKey === hhScreeningPromptKey(question.prompt) && isHhScreeningAnswerComplete(
        question,
        draft?.answer,
        draft?.selectedOptions,
        draft?.confirmedByUser,
      )) {
        answeredMeanings.add(hhScreeningSemanticKey(question.prompt) || question.id);
      }
    }
  }
  return summary.uniqueQuestions.filter(
    (question) => !answeredMeanings.has(hhScreeningSemanticKey(question.prompt) || question.id),
  ).length;
}
