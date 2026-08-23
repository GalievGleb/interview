import type { HhScreeningAnswer, HhScreeningQuestion } from './hhScreeningQuestions';

export interface HhScreeningReviewDraftContext {
  vacancyTitle?: string;
  vacancyCompany?: string;
  resumeText?: string;
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9+#.]+/gi, ' ')
    .trim();
}

function containsNormalized(haystack: string, needle: string): boolean {
  const canonical = (value: string) => normalize(value)
    .split(' ')
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .join(' ');
  const normalizedNeedle = canonical(needle);
  if (normalizedNeedle.length < 3) return false;
  return ` ${canonical(haystack)} `.includes(` ${normalizedNeedle} `);
}

function reviewReason(): string {
  return 'Это неподтверждённый черновик: нужен точный личный факт.';
}

const CONCRETE_RESUME_ACTION_RE = /администр|управл|настра|диагност|анализ|поддерж|разворач|конфигур|автоматиз|тестир|провер|разрабатыва|реализова|создава|работал|использовал|применял/i;
const NEGATED_OR_PROSPECTIVE_RE = /(?:не\s+(?:работал|использовал|применял|занимался)|изучаю|планирую|хочу\s+изучить|готов\s+освоить)/i;

function promptTechnologyTokens(prompt: string): string[] {
  const known = [
    'active directory', 'group policy', 'windows', 'linux', 'astra linux', 'ред ос',
    'kafka', 'nats', 'rabbitmq', 'postman', 'playwright', 'selenium', 'pytest',
    'python', 'java', 'javascript', 'typescript', 'sql', 'api', 'ci/cd', 'gitlab',
  ];
  const normalizedPrompt = normalize(prompt);
  return known.filter((token) => normalizedPrompt.includes(normalize(token)));
}

function concreteResumeEvidence(prompt: string, resumeText: string | undefined): string {
  if (!resumeText?.trim()) return '';
  const technologies = promptTechnologyTokens(prompt);
  if (technologies.length === 0) return '';
  const evidence = resumeText
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12 && line.length <= 420)
    .filter((line) => CONCRETE_RESUME_ACTION_RE.test(line) && !NEGATED_OR_PROSPECTIVE_RE.test(line))
    .filter((line) => technologies.some((token) => containsNormalized(line, token)))
    .slice(0, 2);
  return evidence.join(' ');
}

/**
 * Questions whose answer represents identity, legal/employment status, a
 * preference/commitment, or personal work history. A review fallback may
 * explain what needs confirmation, but must never guess an option for them.
 */
export function isSensitiveHhScreeningChoice(prompt: string): boolean {
  return /гражданств|право\s+на\s+работ|разрешен\w*\s+на\s+работ|судим|военн|арм(?:ия|ии)|трудоустр|официальн|тк\s*рф|трудов\w*\s+(?:договор|опыт)|самозанят|\bип\b|\bгпх\b|зарплат|заработн\w*\s+плат|зарабатывать|получать|сумм|вознагражден|оклад|доход|компенсац|финансов\w*\s+ожидан|город|где.{0,25}жив|жив(?:е|ё)(?:те|шь)|место\s+(?:жительства|проживания)|прожива|локац|местонахожд|релокац|переезд|удален\w*\s+формат|график|смен|дата\s+выхода|за\s+последн|полгода|возраст|сколько\s+лет|дата\s+рожд|образован|диплом|сертифик|английск|уровень\s+язык|виз\w*|здоров|диагноз|инвалид|семейн|женат|замужем|дети|беремен|командиров|ночн\w*\s+(?:смен|работ)|\bnda\b|неразглаш|опыт|работал|использовал|пользовал|пользу(?:е|ё)т|знаком|применял|игр(?:а|ы|ал|али)|мессенджер|расскажите\s+о\s+себе|почему.*(?:ваканси|позици)|чем.*(?:ваканси|позици).*интерес|мотивац|experience|worked\s+with|used|current|currently|city|location|residen|work\s+(?:permit|authorization|status)|military|criminal|visa|health|education|certificate|english\s+level|travel|remote\s+(?:work|only)/i.test(prompt);
}

function pickReviewOptions(
  question: HhScreeningQuestion,
  resumeText: string,
): string[] {
  const options = question.options.map((option) => option.trim()).filter(Boolean);
  if (options.length === 0) return [];

  const neutral = options.find((option) => (
    /^(?:по\s+договоренности|готов\w*\s+обсудить|свой\s+вариант|другое|иное|не\s+указан|нет\s+предпочтен|любой|any|other|not\s+specified)/i
  ).test(option));
  const prompt = question.prompt;
  const asksForSensitiveFact = isSensitiveHhScreeningChoice(prompt);
  const asksForHardStatusOrPreference = /гражданств|право\s+на\s+работ|разрешен\w*\s+на\s+работ|судим|военн|арм(?:ия|ии)|трудоустр|официальн|тк\s*рф|трудов\w*\s+(?:договор|опыт)|самозанят|\bип\b|\bгпх\b|зарплат|оклад|компенсац|финансов\w*\s+ожидан|релокац|переезд|график|смен|дата\s+выхода|за\s+последн|полгода|current|currently|work\s+(?:permit|authorization|status)|military|criminal/i.test(prompt);
  const hasBinaryOption = options.some((option) => /^(?:да|нет|yes|no)(?:\W|$)/i.test(option));
  if (asksForHardStatusOrPreference || (asksForSensitiveFact && hasBinaryOption)) {
    return neutral ? [neutral] : [];
  }

  const resumeMatches = options.filter((option) => containsNormalized(resumeText, option));
  if (resumeMatches.length > 0) {
    return question.kind === 'multiple' ? resumeMatches.slice(0, 6) : resumeMatches.slice(0, 1);
  }
  if (neutral) return [neutral];
  // An arbitrary first/yes/no option is not a draft: it is an unsupported
  // personal claim. Keep the choice empty unless résumé text or a neutral
  // option grounds it.
  return [];
}

function textReviewDraft(
  question: HhScreeningQuestion,
  context: HhScreeningReviewDraftContext,
): string {
  const prompt = question.prompt;
  const vacancyTitle = context.vacancyTitle?.trim() || 'эта позиция';
  const company = context.vacancyCompany?.trim();

  const resumeEvidence = concreteResumeEvidence(prompt, context.resumeText);
  if (resumeEvidence) return resumeEvidence;

  if (/зарплат|оклад|компенсац|финансов\w*\s+ожидан|salary|compensation/i.test(prompt)) {
    return `Ориентируюсь на рыночную компенсацию для позиции «${vacancyTitle}»; точный диапазон готов согласовать с учётом задач, формата работы и совокупного пакета.`;
  }
  if (/аутстафф|outstaff/i.test(prompt)) {
    return 'Отношение к аутстаффингу и обязательные условия сотрудничества нужно подтвердить перед ответом работодателю.';
  }
  if (/ограничен\w*.*(?:мест\w*\s+нахожд|территори|рф|росси|стран)|(?:мест\w*\s+нахожд|территори).*(?:ограничен|рф|росси|стран)|вне\s+рф|за\s+предел\w*\s+рф/i.test(prompt)) {
    return 'Актуальные ограничения по месту нахождения в РФ или за её пределами готов подтвердить и согласовать с работодателем до следующего этапа.';
  }
  if (/релокац|переезд|переехать|relocat/i.test(prompt)) {
    return 'Готовность к релокации, направление, срок и обязательные условия нужно подтвердить перед ответом работодателю.';
  }
  if (/где\s+(?:вы\s+)?(?:сейчас\s+)?(?:жив|наход)|(?:в\s+)?каком\s+городе.{0,60}(?:жив|прожив|наход)|город\w*.{0,60}(?:жив|прожив|нахожд)|локаци|местонахожд|location|city|residen/i.test(prompt)) {
    return '';
  }
  if (/гражданств|право\s+на\s+работ|военн|судим|трудоустр|официальн\w*\s+оформ|самозанят|график|дата\s+выхода|work\s+(?:permit|authorization|status)|military|criminal/i.test(prompt)) {
    return 'Актуальный статус по этому пункту готов подтвердить работодателю перед следующим этапом.';
  }
  if (/почему.*(?:ваканси|позици)|чем.*(?:ваканси|позици).*интерес|мотивац/i.test(prompt)) {
    return `Мне интересна позиция «${vacancyTitle}»${company ? ` в ${company}` : ''}: она позволяет применять мой профиль к реальным задачам продукта, развивать качество и давать измеримый результат команде.`;
  }
  if (/как\s+(?:бы\s+)?(?:вы\s+)?(?:протестир|провер|реш|поступ|организ)|что\s+такое|объясните|чем\s+отлича|how\s+would\s+you|what\s+is/i.test(prompt)) {
    return 'Сначала уточню требования и критерии успеха, затем выделю критичные и граничные сценарии, проверю риски и зафиксирую воспроизводимый результат.';
  }
  if (/опыт|работал|использовал|знаком|применял|experience|worked\s+with|used/i.test(prompt)) {
    return 'Подтверждённый релевантный опыт и инструменты перечислены в моём резюме; готов предметно уточнить глубину опыта по технологиям, которые важны для этой позиции.';
  }
  return 'Готов дать предметный ответ с учётом контекста вакансии; перед отправкой уточню личные факты и оставлю только то, что точно соответствует моему опыту.';
}

/**
 * Last-resort review draft. It is intentionally never eligible for automatic
 * submission: its only job is to keep the editor useful when AI is offline or
 * returns malformed/empty data.
 */
export function buildHhScreeningReviewDraft(
  question: HhScreeningQuestion,
  context: HhScreeningReviewDraftContext = {},
): HhScreeningAnswer {
  const selectedOptions = question.kind === 'text'
    ? []
    : pickReviewOptions(question, context.resumeText ?? '');
  const needsChoice = question.kind !== 'text' && selectedOptions.length === 0;
  const needsSensitiveChoice = needsChoice && isSensitiveHhScreeningChoice(question.prompt);
  return {
    id: question.id,
    answer: question.kind === 'text'
      ? textReviewDraft(question, context)
      : needsChoice
        ? needsSensitiveChoice
          ? 'Выберите точный вариант после проверки личного статуса или опыта: SkillCue не будет угадывать ответ «Да» или «Нет».'
          : 'Выберите подходящий вариант вручную: SkillCue не будет угадывать неподтверждённый ответ.'
        : '',
    selectedOptions,
    canAutoFill: false,
    sourceType: 'none',
    evidenceQuote: '',
    reason: reviewReason(),
  };
}

export function isUsableHhScreeningDraft(
  question: HhScreeningQuestion,
  answer: Pick<HhScreeningAnswer, 'answer' | 'selectedOptions'> | undefined,
): boolean {
  if (!answer) return false;
  return question.kind === 'text'
    ? Boolean(answer.answer.trim())
    : answer.selectedOptions.length > 0 || Boolean(answer.answer.trim());
}
