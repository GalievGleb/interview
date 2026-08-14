import type { HhQueueItem, HhScreeningQuestion } from '../types/electron';

export const HH_SCREENING_DRAFTS_STORAGE_KEY = 'skillcue.hhHrProfileDrafts.v1';

export interface HhScreeningLocalDraft {
  answer: string;
  selectedOptions: string[];
  confirmedByUser: boolean;
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
  const scope = hhScreeningRelocationScope(value);
  return scope === 'russia' || scope === 'abroad'
    ? `preference:relocation:${scope}`
    : hhScreeningPromptKey(value);
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
      if (isHhScreeningAnswerComplete(
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
