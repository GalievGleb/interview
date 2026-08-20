import {
  matchScreeningOptionLabels,
  normalizeScreeningOption,
  screeningQuestionKey,
  type HhScreeningAnswer,
  type HhScreeningQuestion,
} from './hhScreeningQuestions';

export interface ConfirmedScreeningFact {
  question: string;
  answer: string;
  selectedOptions: string[];
  updatedAt?: string;
}

const STOP_WORDS = new Set([
  'был', 'была', 'были', 'вас', 'ваш', 'ваша', 'ваши', 'есть', 'для', 'или', 'как', 'какие',
  'какой', 'какую', 'каком', 'либо', 'можете', 'опишите', 'опыт', 'ответ', 'работа', 'работали',
  'работы', 'свой', 'свою', 'чего', 'что', 'этой', 'этот', 'этого', 'with', 'your', 'have', 'what',
  'which', 'work', 'worked', 'experience', 'describe', 'please',
]);

const SALARY_QUESTION_RE = /(?:зарплат|заработн[а-яё]*\s+плат|вознагражден|з\s*\/?\s*п\b|оклад|доход|компенсац|оплат|денежн|вилк|финансов[а-яё]*\s+ожидан|salary|compensation|financial\s+expectations?|expected\s+(?:salary|compensation|pay|level)|\bpay\b)/i;
const SALARY_RELATED_QUESTION_RE = /(?:зарплат|заработн[а-яё]*\s+плат|вознагражден|з\s*\/?\s*п\b|оклад|доход|компенсац|оплат|денежн|вилк|финансов[а-яё]*\s+ожидан|сумм|рейт|ставк|гонорар|salary|compensation|financial\s+expectations?|\bpay\b|\brate\b|\bfee\b)/i;
const HISTORICAL_SALARY_QUESTION_RE = /(?:текущ\w*\s+(?:доход|зарплат|заработн[а-яё]*\s+плат|оклад|компенсац)|(?:зарплат|заработн[а-яё]*\s+плат|доход|оклад|компенсац).{0,45}(?:получал|получаете|получали|зарабатыва(?:ли|ете|ешь)|предыдущ|прошл|последн\w*\s+мест)|(?:получал|получаете|получали|зарабатыва(?:ли|ете|ешь)).{0,45}(?:зарплат|заработн[а-яё]*\s+плат|доход|оклад|компенсац)|(?:сколько|какую\s+сумм\w*).{0,35}(?:сейчас\s+)?(?:получал|получаете|получали|зарабатыва(?:ли|ете|ешь))|current\s+(?:salary|income|compensation)|(?:last|previous)\s+(?:salary|income|compensation))/i;
const NON_MONTHLY_SALARY_CADENCE_RE = /(?:(?:в|за|на)\s+(?:час|день|сутк\w*|смен\w*|недел\w*|год|квартал|полугод\w*)|(?:за|на)\s+(?:(?:\d+|один|одну|дв[ае]|три|четыре|пять|шесть|семь|восемь|девять|десять)\s+)?(?:дн\w*|сутк\w*|смен\w*|недел\w*|месяц\w*|квартал\w*|полугод\w*|год\w*)|за\s+(?:весь\s+)?(?:проект|контракт)|\/\s*(?:час|день|сутк\w*|смен\w*|недел\w*|год)|почасов|часов\w*\s+ставк|дневн\w*\s+ставк|годов\w*\s+(?:доход|зарплат|компенсац)|ежегодн|ежеквартальн|per\s+(?:hour|day|shift|week|year|annum|project|contract)|hourly|daily|weekly|quarterly|annual|yearly)/i;
const NON_RUBLE_SALARY_CURRENCY_RE = /(?:\b(?:usd|eur|kzt|aed|gbp|cny|byn|gel|amd|uzs|try|inr|cad|chf|jpy|krw|brl|zar|sek|nok|dkk|pln|czk|huf|ron|bgn|rsd|thb|vnd|idr|mxn|ars|clp|aud|nzd|sgd|hkd|twd|myr|php|uah|ils|sar|qar|kwd|bhd|omr|egp|mad|ngn|kes|ghs|etb|usdt|usdc)\b|[$€₸₾֏¥₴]|доллар|евро|тенге|дирхам|фунт[а-яё]*|иен[а-яё]*|йен[а-яё]*|юан|гривн|белорусск[а-яё]*\s+рубл|лари|драм|(?:сом|сум)(?:ы|ов|ах)?(?![а-яё]))/i;
const EXPECTED_SALARY_QUESTION_RE = /(?:ожидан|ожида|желаем|миним|комфорт|вилк|рассчитыва|ориентир|рассматрива|хот(?:ите|ел(?:и|а)?|им|елось)|интересу(?:ет|ют)|устроит|expected|desired|expectations?)/i;
const BARE_EXPECTED_PAY_QUESTION_RE = /(?:(?:сколько|какую\s+сумм\w*)[^?\n]{0,45}(?:хот(?:ите|ели|им)|ожида(?:ете|ем|ю))[^?\n]{0,30}(?:получать|зарабатывать)|желаем[а-яё]*\s+сумм[а-яё]*[^?\n]{0,25}(?:на\s+руки|в\s+месяц))/i;
const EXPECTED_SUM_SALARY_QUESTION_RE = /(?:сумм[а-яё]*[^?\n]{0,45}(?:рассчитыва|ориентир|рассматрива|устроит)|(?:рассчитыва|ориентир|рассматрива|устроит)[^?\n]{0,45}сумм[а-яё]*)/i;
const EXPLICIT_SALARY_EXPECTATION_LINE_RE = /(?:финансов[а-яё]*\s+ожидан|зарплатн[а-яё]*\s+ожидан|(?:желаем|ожидаем|expected|desired).{0,40}(?:зарплат|доход|компенсац|оплат|salary|income|compensation)|(?:зарплат|доход|компенсац|оплат|salary|income|compensation).{0,40}(?:желаем|ожидаем|expected|desired))/i;
const NON_EXPECTATION_MONEY_LINE_RE = /(?:бюджет|оборот|выручк|расход|получал|получаю|получает|текущ(?:ая|ий|ее)\s+(?:зарплат|доход|оклад)|предыдущ(?:ая|ий|ее)|прошл(?:ая|ый|ое)\s+(?:зарплат|доход|оклад))/i;
const SALARY_NET_BASIS_RE = /(?:на\s+руки|после\s+(?:(?:вычета|уплаты)\s+)?(?:налог|ндфл)|чист(?:ыми|ая|ый)(?![а-яё])|\bnet\b)/i;
const SALARY_GROSS_BASIS_RE = /(?:до\s+(?:(?:вычета|уплаты)\s+)?(?:налог|ндфл)|до\s+удержан|с\s+уч[её]том\s+(?:налог|ндфл)|грязн(?:ыми|ая|ый)(?![а-яё])|\bgross\b)/i;
const SALARY_TAX_MENTION_RE = /(?:налог|ндфл|вычет|удержан|на\s+руки|чист(?:ыми|ая|ый)(?![а-яё])|грязн(?:ыми|ая|ый)(?![а-яё])|\bnet\b|\bgross\b)/i;

function hasExplicitNonRubleSalaryCurrency(value: string): boolean {
  if (NON_RUBLE_SALARY_CURRENCY_RE.test(value)) return true;
  const currencyCodes = value.match(/\b[A-Z]{3,5}\b/g) ?? [];
  return currencyCodes.some((code) => code !== 'RUB' && code !== 'RUR');
}

/** Broad provenance boundary; it does not by itself authorize an automatic answer. */
export function isSalaryRelatedQuestion(value: string): boolean {
  return SALARY_RELATED_QUESTION_RE.test(value) || isSalaryExpectationQuestion(value);
}

export function isSalaryExpectationQuestion(value: string): boolean {
  if (
    HISTORICAL_SALARY_QUESTION_RE.test(value)
    || NON_MONTHLY_SALARY_CADENCE_RE.test(value)
    || hasExplicitNonRubleSalaryCurrency(value)
  ) return false;
  return (SALARY_QUESTION_RE.test(value) && EXPECTED_SALARY_QUESTION_RE.test(value))
    || BARE_EXPECTED_PAY_QUESTION_RE.test(value)
    || EXPECTED_SUM_SALARY_QUESTION_RE.test(value);
}
const MONEY_RE = /(\d{2,3}(?:[\s\u00a0]\d{3})+|\d{5,7})\s*(?:₽|руб(?:\.|лей|ля)?|rub\b)/giu;
const RELOCATION_RE = /релокац|переезд|переехать|перебраться|сменить\s+(?:город|место\s+жительства)/i;
const REGIONAL_LOCATION_QUESTION_RE = /(?:регион|област|субъект(?:а)?\s*(?:рф|российск[а-яё]*\s+федерац)?|край|республик)/i;
const CURRENT_LOCATION_QUESTION_RE = /(?:где\s+(?:сейчас\s+)?(?:жив(?:е|ё)(?:те|шь)|прожива(?:е|ё)(?:те|шь)|находитесь)(?![а-яё])|в\s+как(?:ом|ой)\s+(?:городе|регионе|насел[её]нн[а-яё]*\s+пункте|локации)[^?\n]{0,35}(?:(?:вы|кандидат)[^?\n]{0,12})?(?:жив|прожив|находитесь|находится\s+кандидат)|где[^?\n]{0,35}(?:(?:вы|кандидат)[^?\n]{0,12})(?:жив|прожив|наход)|(?:укаж|назов|напиш)[^?\n]{0,25}(?:город|локац|насел[её]нн[а-яё]*\s+пункт)[^?\n]{0,30}(?:проживания|жительства|местонахождения)[\s?.:]*$|(?:укаж|назов|напиш)[а-яё]*[\s,:-]*(?:пожалуйста[\s,:-]*)?(?:(?:ваш[а-яё]*\s+)?(?:текущ[а-яё]*\s+)?(?:город|локац|насел[её]нн[а-яё]*\s+пункт)|место\s+(?:жительства|проживания)|местонахожд)[\s?.:]*$|(?:город|регион|насел[её]нн[а-яё]*\s+пункт)\s+(?:вашего\s+)?(?:фактическ[а-яё]*\s+)?(?:проживания|местонахождения)|(?:(?:ваш[а-яё]*\s+)?(?:текущ[а-яё]*|фактическ[а-яё]*)|ваш[а-яё]*)\s+(?:город|локац|место\s+(?:жительства|проживания)|местонахожд))/i;
const NON_CURRENT_LOCATION_QUESTION_RE = /(?:город|место|локац|насел[её]нн[а-яё]*\s+пункт).{0,50}(?:рождени|родн[а-яё]*|регистрац|пропис|офис|работодател|ваканси|компан|проект|команд|образован|обучен|работ|желаем|желательн|предпочитаем)|(?:рождени|родн[а-яё]*|регистрац|пропис|офис|работодател|ваканси|компан|проект|команд|образован|обучен|работ|желаем|желательн|предпочитаем).{0,50}(?:город|место|локац|насел[её]нн[а-яё]*\s+пункт)/i;
const FOREIGN_RELOCATION_RE = /за\s+(?:рубеж|границ)|другую\s+стран|саудов|оаэ|эмират|дуба[йе]|кипр|турц|грузи|тбилис|армени|ереван|казахстан|алмат|астан|кыргыз|бишкек|узбекистан|ташкент|серби|белград|черногор|европ|германи|польш|чехи|израил|сша|америк|канад|испан|португал|франц|итал|нидерланд|голланд|бельги|австри|швейцар|швец|норвег|финлянд|дани|великобритан|англи|ирланд|румын|болгар|венгр|хорват|словен|словац|литв|латви|эстон|грец|беларус|белорус|минск|украин|киев|молдов|кишинев|азербайджан|баку|мексик|бразил|аргентин|чили|австрали|нов(?:ую|ая)?\s+зеланд|индонез|таиланд|вьетнам/i;
const RUSSIAN_RELOCATION_RE = /(?:^|[^а-яё])(?:росси|рф(?=$|[^а-яё])|москв|санкт[ -]?петербург|петербург|питер|рязань|йошкар|казан|иннополис|новосибир|екатеринбург|нижн(?:ий|его)\s+новгород|самар|уф[ауе]|перм|омск|челябинск|ростов|краснодар|красноярск|воронеж|волгоград|соч[и]|тюмень|томск|саратов|тольятти|ижевск|барнаул|владивосток|хабаровск|калининград|ярославл|тула|иркутск|ульяновск)/i;

export type ScreeningRelocationScope = 'russia' | 'abroad' | 'unspecified';

const CURRENT_LOCATION_SEMANTIC_KEY = 'profile:current-location';

/** True only for a request for the candidate's present home location. */
export function isCurrentLocationQuestion(value: string): boolean {
  return !RELOCATION_RE.test(value)
    && !REGIONAL_LOCATION_QUESTION_RE.test(value)
    && !NON_CURRENT_LOCATION_QUESTION_RE.test(value)
    && CURRENT_LOCATION_QUESTION_RE.test(value);
}

export function screeningRelocationScope(value: string): ScreeningRelocationScope | null {
  if (!RELOCATION_RE.test(value)) return null;
  if (FOREIGN_RELOCATION_RE.test(value)) return 'abroad';
  if (RUSSIAN_RELOCATION_RE.test(value)) return 'russia';
  // Неизвестную локацию нельзя безопасно считать российской: пользователь
  // может быть готов к переезду за границу, но не по России.
  return 'unspecified';
}

/**
 * Exact prompts remain isolated. Only a small set of preference questions is
 * grouped, and Russian/international relocation are deliberately different.
 */
export function screeningQuestionSemanticKey(value: string): string {
  if (isCurrentLocationQuestion(value)) return CURRENT_LOCATION_SEMANTIC_KEY;
  // Destination-specific relocation questions must remain separate in
  // storage and in the UI. A confirmed global refusal can still be reused by
  // reusableScreeningAnswer, but “Рязань” and “Йошкар-Ола” must never collapse
  // into one stored value.
  return screeningQuestionKey(value);
}

type ScreeningPreferenceIntent = 'accept' | 'decline' | 'discuss';

function screeningPreferenceIntent(fact: ConfirmedScreeningFact): ScreeningPreferenceIntent | null {
  const value = [fact.answer, ...fact.selectedOptions].join(' ').toLocaleLowerCase('ru').replace(/ё/g, 'е');
  if (/(?:^|[^а-яё])нет(?=$|[^а-яё])|не\s+готов|не\s+рассматрива|только(?:\s+полностью)?\s+удален|в\s+своем\s+городе|без\s+переезд/.test(value)) return 'decline';
  if (/обсуд|зависит|услови|скорее|не\s+уверен/.test(value)) return 'discuss';
  if (/(?:^|[^а-яё])да(?=$|[^а-яё])|готов.{0,30}(?:переех|релокац)|рассматрива.{0,30}(?:переезд|релокац)/.test(value)) return 'accept';
  return null;
}

function relocationOptionForIntent(options: string[], intent: ScreeningPreferenceIntent): string | null {
  const scored = options.map((option) => {
    const value = option.toLocaleLowerCase('ru').replace(/ё/g, 'е');
    let score = 0;
    if (intent === 'decline') {
      // A confirmed refusal to relocate does not prove willingness to commute,
      // visit an office, or work hybrid even when the option starts with “Нет”.
      if (/(?:^|[^а-яё])но(?=$|[^а-яё])|готов.{0,30}(?:приезж|ездить|посещ|офис)|офис|гибрид|в\s+своем\s+городе/.test(value)) {
        return { option, score: Number.NEGATIVE_INFINITY };
      }
      if (/(?:^|[^а-яё])нет(?=$|[^а-яё])|не\s+готов|не\s+рассматрива/.test(value)) score += 8;
      if (/только(?:\s+полностью)?\s+удален|без\s+переезд/.test(value)) score += 6;
    } else if (intent === 'accept') {
      if (/(?:^|[^а-яё])да(?=$|[^а-яё])/.test(value)) score += 6;
      if (/готов.{0,30}(?:переех|релокац)|переехать/.test(value)) score += 7;
      if (/проживаю/.test(value)) score -= 6;
    } else {
      if (/обсуд|зависит|услови|скорее|не\s+уверен/.test(value)) score += 8;
    }
    return { option, score };
  }).sort((left, right) => right.score - left.score);
  return scored[0] && scored[0].score > 0 ? scored[0].option : null;
}

function locationOptionForValue(options: string[], location: string): string | null {
  const normalizedLocation = normalizeScreeningOption(location);
  if (normalizedLocation.length < 2) return null;
  return options.find((option) => {
    const normalized = normalizeScreeningOption(option);
    if (/^(?:не|кроме|за\s+исключением|любой\s+кроме|вне|за\s+пределами)(?=$|[^а-яё])/.test(normalized)) return false;
    return normalized === normalizedLocation
      || normalized === `г ${normalizedLocation}`
      || normalized === `г. ${normalizedLocation}`
      || normalized === `город ${normalizedLocation}`
      || normalized === `${normalizedLocation} и область`
      || normalized === `г ${normalizedLocation} и область`
      || normalized === `г. ${normalizedLocation} и область`
      || normalized === `город ${normalizedLocation} и область`;
  }) ?? null;
}

function isGlobalRelocationDecline(fact: ConfirmedScreeningFact): boolean {
  const value = [fact.answer, ...fact.selectedOptions]
    .join(' ')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е');
  return /(?:только(?:\s+полностью)?\s+удален|без\s+переезд(?:а|ов)?(?:\s+вообще)?|переезд(?:ы)?(?:\s+по\s+россии|\s+вообще)?\s+не\s+рассматрива|не\s+рассматрива.{0,25}переезд(?:ы)?(?:\s+по\s+россии|\s+вообще)?|ни\s+в\s+какой\s+город)/.test(value);
}

/** Maps one confirmed preference to a differently worded form question. */
export function reusableScreeningAnswer(
  question: HhScreeningQuestion,
  fact: ConfirmedScreeningFact,
): HhScreeningAnswer | null {
  const exact = screeningQuestionKey(question.prompt) === screeningQuestionKey(fact.question);
  const semanticKey = screeningQuestionSemanticKey(question.prompt);
  const questionRelocationScope = screeningRelocationScope(question.prompt);
  const factRelocationScope = screeningRelocationScope(fact.question);
  const sameRelocationScope = Boolean(questionRelocationScope)
    && questionRelocationScope === factRelocationScope;
  const sameMeaning = semanticKey === screeningQuestionSemanticKey(fact.question)
    || sameRelocationScope;
  const sameCurrentLocation = sameMeaning && semanticKey === CURRENT_LOCATION_SEMANTIC_KEY;
  if (!exact && !sameMeaning) return null;
  const intent = screeningPreferenceIntent(fact);
  // A refusal aimed at one city is destination-specific too. Only an explicit
  // global/remote-only refusal may be reused for a differently worded place.
  if (
    !exact
    && sameMeaning
    && !sameCurrentLocation
    && (intent !== 'decline' || !isGlobalRelocationDecline(fact))
  ) return null;
  if (question.kind === 'text') {
    const answer = fact.answer.trim() || fact.selectedOptions.join(', ').trim();
    return answer ? { id: question.id, answer, selectedOptions: [], canAutoFill: true, reason: '' } : null;
  }
  const exactOptions = matchScreeningOptionLabels(
    fact,
    question.options,
    question.kind === 'multiple',
  );
  if (exactOptions.length > 0) {
    return { id: question.id, answer: fact.answer, selectedOptions: exactOptions, canAutoFill: true, reason: '' };
  }
  if (sameCurrentLocation) {
    const location = fact.answer.trim() || fact.selectedOptions[0]?.trim() || '';
    const mappedLocation = locationOptionForValue(question.options, location);
    if (mappedLocation) {
      return { id: question.id, answer: '', selectedOptions: [mappedLocation], canAutoFill: true, reason: '' };
    }
  }
  const mapped = intent && relocationOptionForIntent(question.options, intent);
  return mapped
    ? { id: question.id, answer: '', selectedOptions: [mapped], canAutoFill: true, reason: '' }
    : null;
}

const PROFESSIONAL_OPTION_RULES: Array<{
  question: RegExp;
  option: RegExp;
  preparationNote?: string;
}> = [
  { question: /критическ.*модул.*быстро.*не упал/i, option: /smoke-тестирован/i },
  { question: /изменение.*модул.*связанн.*систем/i, option: /целенаправленное регрессионное.*интеграц/i },
  { question: /внутренн.*структур.*код.*покрытие ветвлен/i, option: /белого ящика/i },
  { question: /оптимизац.*тестов.*набор.*покрыт/i, option: /техник.*тест-дизайна/i },
  { question: /пользователь сообщает.*некорректн/i, option: /соберу данные.*логи.*тикет/i },
  { question: /новая функция.*что тестируете.*перв/i, option: /основной сценарий/i },
  { question: /функц.*бонус.*иногда.*неправильн/i, option: /матриц.*тест.*граничн/i },
  { question: /после обновления.*падать.*устройств/i, option: /логи крашей.*модел.*устройств/i },
  { question: /этап.*новой фич.*техническ.*описан/i, option: /этапе проработки ТО.*до его утверждения/i },
  { question: /когда.*автотест.*новой фич/i, option: /параллельно с разработкой.*юнит.*API/i },
  { question: /как понять.*фич.*готова.*релиз/i, option: /критерии успешности.*уровни тестирования/i },
  { question: /приоритет автоматизац/i, option: /часто используются.*влияние.*бизнес/i },
  { question: /минимизир.*время прогона.*автотест/i, option: /пирамид.*тестирован/i },
  { question: /QA.*эффективно участвовать.*разработк/i, option: /ранних стадиях.*оценивая риски/i },
];

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase('ru')
      .replace(/ё/g, 'е')
      .split(/[^a-zа-я0-9+#.]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function relevance(fact: ConfirmedScreeningFact, questions: HhScreeningQuestion[]): number {
  const exact = questions.some(
    (question) => screeningQuestionKey(question.prompt) === screeningQuestionKey(fact.question),
  );
  if (exact) return 10_000;
  const samePreference = questions.some(
    (question) => screeningQuestionSemanticKey(question.prompt) === screeningQuestionSemanticKey(fact.question),
  );
  if (samePreference) return 9_000;
  const factTokens = tokens(fact.question);
  let best = 0;
  for (const question of questions) {
    const questionTokens = tokens(question.prompt);
    let shared = 0;
    for (const token of factTokens) {
      if (questionTokens.has(token)) shared += Math.min(12, token.length);
    }
    best = Math.max(best, shared);
  }
  return best;
}

/**
 * Keeps old but relevant candidate facts available to the model. Taking only
 * the last N answers made a known fact disappear after enough unrelated HH
 * forms had been processed.
 */
export function selectRelevantScreeningFacts<T extends ConfirmedScreeningFact>(
  facts: T[],
  questions: HhScreeningQuestion[],
  limit = 30,
): T[] {
  return facts
    .map((fact, index) => ({ fact, index, score: relevance(fact, questions) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, Math.max(0, limit))
    .map(({ fact }) => fact);
}

function salaryExpectationEvidence(sourceText: string): string[] {
  const lines = sourceText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines.length <= 1
    ? lines.filter((line) => !NON_EXPECTATION_MONEY_LINE_RE.test(line))
    : lines.filter((line, index) => (
      EXPLICIT_SALARY_EXPECTATION_LINE_RE.test(line)
      || (index === 0 && !NON_EXPECTATION_MONEY_LINE_RE.test(line))
    )))
    .filter((line) => !NON_MONTHLY_SALARY_CADENCE_RE.test(line));
}

type SalaryTaxBasis = 'net' | 'gross';

function salaryTaxBasis(value: string): SalaryTaxBasis | 'ambiguous' | null {
  const net = SALARY_NET_BASIS_RE.test(value);
  const gross = SALARY_GROSS_BASIS_RE.test(value);
  if (net && gross) return 'ambiguous';
  if (net) return 'net';
  if (gross) return 'gross';
  return null;
}

function salaryTaxBasisForAmount(
  salaryExpectation: number,
  sourceText: string,
): SalaryTaxBasis | 'ambiguous' | null {
  const bases = new Set<SalaryTaxBasis>();
  for (const segment of salaryExpectationEvidence(sourceText)) {
    MONEY_RE.lastIndex = 0;
    for (const match of segment.matchAll(MONEY_RE)) {
      const amount = Number((match[1] ?? '').replace(/[\s\u00a0]/g, ''));
      if (amount !== salaryExpectation) continue;
      const start = Math.max(0, (match.index ?? 0) - 35);
      const end = Math.min(segment.length, (match.index ?? 0) + match[0].length + 50);
      const basis = salaryTaxBasis(segment.slice(start, end));
      if (basis === 'ambiguous') return 'ambiguous';
      if (basis) bases.add(basis);
    }
  }
  return bases.size === 1 ? [...bases][0] : bases.size > 1 ? 'ambiguous' : null;
}

/** Extracts the desired monthly salary from the explicit setting or HH résumé. */
export function findSalaryExpectation(
  configuredSalary: number | null | undefined,
  sources: string[],
): number | null {
  for (const source of sources) {
    for (const segment of salaryExpectationEvidence(source)) {
      MONEY_RE.lastIndex = 0;
      for (const match of segment.matchAll(MONEY_RE)) {
        const value = Number((match[1] ?? '').replace(/[\s\u00a0]/g, ''));
        if (Number.isFinite(value) && value >= 30_000 && value <= 10_000_000) return value;
      }
    }
  }
  // salaryFrom is primarily the HH search floor. It is still a useful fallback
  // when the chosen résumé contains no salary, but it must never override the
  // explicit expectation printed in that exact résumé.
  if (Number.isFinite(configuredSalary) && Number(configuredSalary) >= 30_000) {
    return Math.round(Number(configuredSalary));
  }
  return null;
}

/** Reads the current city from the explicitly selected HH résumé. */
export function findResumeLocation(resumeText: string): string | null {
  const labelled = resumeText.match(
    /(?:^|\n)\s*(?:город(?:\s+(?:проживания|жительства))?|место\s+(?:жительства|проживания)|локация|местонахождение)\s*[:—-]\s*([^\n]{2,120})/iu,
  )?.[1]?.trim();
  const hhHeader = resumeText.match(
    /(?:^|\n)\s*([А-ЯЁ][А-Яа-яЁё-]+(?:\s+[А-ЯЁ][А-Яа-яЁё-]+){0,3})\s*,?\s+(?=(?:не\s+)?готов(?:а)?\s+к\s+переезду)/u,
  )?.[1]?.trim();
  const raw = labelled || hhHeader;
  if (!raw) return null;
  const parts = raw
    .split(/\s*[,;|·]\s*/u)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const candidate = /^(?:росси(?:я|йская федерация)|рф)$/iu.test(parts[0] ?? '')
    ? parts[1]
    : parts[0];
  if (!candidate || candidate.length > 80) return null;
  if (/\d|https?:|@|готов\w*\s+к\s+переезду|удален/i.test(candidate)) return null;
  return candidate;
}

function formatRubles(value: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)} ₽`;
}

/** Builds the same factual salary answer for HH forms and recruiter chats. */
export function buildSalaryExpectationAnswer(
  salaryExpectation: number,
  question: string,
  sourceText = '',
): string {
  const salary = formatRubles(salaryExpectation);
  const requestedBasis = salaryTaxBasis(question);
  const sourceBasis = salaryTaxBasisForAmount(salaryExpectation, sourceText);
  if (requestedBasis === 'ambiguous' || sourceBasis === 'ambiguous') return '';
  if (SALARY_TAX_MENTION_RE.test(question) && !requestedBasis) return '';
  if (requestedBasis && sourceBasis !== requestedBasis) return '';
  const qualifier = sourceBasis === 'net'
    ? 'на руки'
    : sourceBasis === 'gross' ? 'до вычета налогов' : 'в месяц';
  const asksForRange = /(?:миним|комфорт|вилк|от\s+и\s+до)/i.test(question);
  return asksForRange
    ? `Минимум — ${salary} ${qualifier}; комфортный уровень готов обсудить с учётом задач и общего компенсационного пакета.`
    : `Рассматриваю предложения от ${salary} ${qualifier}, итоговый уровень готов обсудить с учётом задач и общего компенсационного пакета.`;
}

function resumeExperienceDuration(resumeText: string): string {
  return resumeText.match(/Опыт работы:\s*([^\n•]{2,40})/i)?.[1]?.trim() ?? '';
}

/** Reads the total experience displayed by HH at the top of a selected résumé. */
export function findResumeExperienceMonths(resumeText: string): number | null {
  const duration = resumeExperienceDuration(resumeText);
  if (!duration) return null;
  const years = Number(duration.match(/(\d+)\s*(?:год(?:а|ов)?|лет)(?=\s|$)/i)?.[1] ?? '0');
  const months = Number(duration.match(/(\d+)\s*месяц(?:а|ев)?(?=\s|$)/i)?.[1] ?? '0');
  const total = years * 12 + months;
  return total > 0 ? total : null;
}

/** Answers an explicit experience threshold only when the résumé proves it. */
export function answerExperienceThresholdFromResume(
  question: string,
  resumeText: string,
): 'Да' | 'Нет' | null {
  const asksTotalExperience = /(?:общ(?:ий|ая)\s+(?:опыт|стаж)|суммарн[а-яё]*\s+(?:опыт|стаж)|(?:опыт|стаж)\s+работы\s+всего|всего\s+(?:опыт|стаж))/i.test(question);
  const asksAutomationExperience = /(?:авто\s*тест|автотест|автоматизац[а-яё]*\s+тест|test\s+automation)/i.test(question);
  if (!asksTotalExperience && !asksAutomationExperience) return null;
  const threshold = question.match(/(\d+(?:[.,]\d+)?)\s*(?:год(?:а|ов)?|лет)(?=\s|[?!.,)}\]]|$)/i);
  if (!threshold) return null;
  const thresholdMonths = Math.round(Number(threshold[1].replace(',', '.')) * 12);
  if (!Number.isFinite(thresholdMonths) || thresholdMonths <= 0) return null;
  const experienceMonths = findResumeExperienceMonths(resumeText);
  if (asksAutomationExperience) {
    // The selected HH resume itself is for an automation/fullstack-QA role.
    // For the common entry threshold "from one year", that explicit profile
    // positioning plus automation tooling is enough to answer positively even
    // when HH's compact resume text omits the total-tenure header. Never infer
    // a larger specialist duration from total career tenure.
    const selectedResumeSignalsAutomation = /(?:qa\s*automation|automation\s*(?:qa|engineer)|\baqa\b|(?:full\s*stack|fullstack)\s*qa|qa\s*(?:full\s*stack|fullstack)|автоматизац[а-яё]*\s+тест|автотест|pytest|playwright|selenium)/i.test(
      resumeText,
    );
    if (!selectedResumeSignalsAutomation || thresholdMonths > 12) return null;
    if (experienceMonths != null && experienceMonths < thresholdMonths) return null;
    return 'Да';
  }
  if (experienceMonths == null) return null;
  if (/(?:более|свыше|больше)/i.test(question)) {
    return experienceMonths > thresholdMonths ? 'Да' : 'Нет';
  }
  if (/(?:не\s+менее|минимум|от\s+\d)/i.test(question)) {
    return experienceMonths >= thresholdMonths ? 'Да' : 'Нет';
  }
  return null;
}

/**
 * Deterministic answers for preferences SkillCue already has. These win over
 * the model, so an obvious salary question cannot become a manual blocker.
 */
export function knownScreeningAnswer(
  question: HhScreeningQuestion,
  salaryExpectation: number | null,
  resumeText = '',
): HhScreeningAnswer | null {
  if (question.kind === 'text' && salaryExpectation && isSalaryExpectationQuestion(question.prompt)) {
    const answer = buildSalaryExpectationAnswer(salaryExpectation, question.prompt, resumeText);
    if (!answer) return null;
    return {
      id: question.id,
      answer,
      selectedOptions: [],
      canAutoFill: true,
      reason: '',
    };
  }

  if (isCurrentLocationQuestion(question.prompt)) {
    const location = findResumeLocation(resumeText);
    if (location && question.kind === 'text') {
      return {
        id: question.id,
        answer: location,
        selectedOptions: [],
        canAutoFill: true,
        sourceType: 'resume',
        evidenceQuote: `Город проживания: ${location}`,
        reason: '',
      };
    }
    if (location) {
      const option = locationOptionForValue(question.options, location);
      if (option) {
        return {
          id: question.id,
          answer: '',
          selectedOptions: [option],
          canAutoFill: true,
          sourceType: 'resume',
          evidenceQuote: `Город проживания: ${location}`,
          reason: '',
        };
      }
    }
  }

  const experienceThresholdAnswer = answerExperienceThresholdFromResume(
    question.prompt,
    resumeText,
  );
  if (experienceThresholdAnswer) {
    if (question.kind === 'text') {
      return {
        id: question.id,
        answer: experienceThresholdAnswer,
        selectedOptions: [],
        canAutoFill: true,
        sourceType: 'resume',
        evidenceQuote: resumeText.split(/\r?\n/u).find((line) => line.trim())?.trim().slice(0, 300),
        reason: '',
      };
    }
    const normalizedAnswer = normalizeScreeningOption(experienceThresholdAnswer);
    const exact = question.options.find(
      (option) => normalizeScreeningOption(option) === normalizedAnswer,
    );
    const positiveOptions = experienceThresholdAnswer === 'Да'
      ? question.options.filter((option) => /^да(?:\b|[,.])/iu.test(option.trim()))
      : [];
    const resumeLanguage = [
      { signal: /\bpython\b|питон/iu, option: /\bpython\b|питон/iu },
      { signal: /\bjava\b/iu, option: /\bjava\b/iu },
      { signal: /(?:\bc#\b|\.net\b|csharp)/iu, option: /(?:\bc#\b|\.net\b|csharp)/iu },
    ].find(({ signal }) => signal.test(resumeText));
    const groundedLanguageOption = resumeLanguage
      ? positiveOptions.find((option) => resumeLanguage.option.test(option))
      : undefined;
    const selected = exact
      ?? groundedLanguageOption
      ?? (positiveOptions.length === 1 ? positiveOptions[0] : undefined);
    if (selected) {
      return {
        id: question.id,
        answer: '',
        selectedOptions: [selected],
        canAutoFill: true,
        sourceType: 'resume',
        evidenceQuote: resumeText.split(/\r?\n/u).find((line) => line.trim())?.trim().slice(0, 300),
        reason: '',
      };
    }
  }

  if (question.kind !== 'text') {
    const rule = PROFESSIONAL_OPTION_RULES.find((candidate) => candidate.question.test(question.prompt));
    const selected = rule && question.options.find((option) => rule.option.test(option));
    if (!selected) return null;
    return {
      id: question.id,
      answer: '',
      selectedOptions: [selected],
      canAutoFill: true,
      reason: '',
      preparationNote: rule.preparationNote,
    };
  }

  if (/compress_numbers|подряд идущие дубликаты/i.test(question.prompt)) {
    return {
      id: question.id,
      answer: `def compress_numbers(numbers):\n    result = []\n    for number in numbers:\n        if not result or result[-1] != number:\n            result.append(number)\n    return result\n\ndef test_compress_numbers():\n    assert compress_numbers([]) == []\n    assert compress_numbers([1]) == [1]\n    assert compress_numbers([1, 1, 2, 2, 3]) == [1, 2, 3]\n    assert compress_numbers([0, 0, 1, 1, 0]) == [0, 1, 0]\n    assert compress_numbers([-1, -1, -1]) == [-1]\n    assert compress_numbers([1, 2, 1]) == [1, 2, 1]`,
      selectedOptions: [], canAutoFill: true, reason: '',
    };
  }
  if (/неясн.*задач.*матчмейкинг.*лучше/i.test(question.prompt)) {
    return {
      id: question.id,
      answer: 'Сначала уточню, что означает «лучше» для продукта и игроков: скорость подбора, баланс, пинг, удержание или доля отмен. Затем зафиксирую измеримые критерии, сегменты и ограничения, изучу текущие метрики и жалобы, после чего составлю риски и проверяемые гипотезы для эксперимента.',
      selectedOptions: [], canAutoFill: true, reason: '',
    };
  }
  return null;
}

/**
 * Keeps the interactive suggestion useful when the remote model is temporarily
 * unavailable. These are deliberately never marked safe for automatic filling:
 * the user sees and confirms the hypothesis before it becomes a candidate fact.
 */
export function localScreeningDraft(
  question: HhScreeningQuestion,
  vacancyTitle = '',
  vacancyCompany = '',
): HhScreeningAnswer | null {
  const prompt = question.prompt;
  const draft = (answer: string, selectedOptions: string[] = []): HhScreeningAnswer => ({
    id: question.id,
    answer,
    selectedOptions,
    canAutoFill: false,
    reason: 'Это предположение SkillCue — проверьте и отредактируйте его перед сохранением.',
  });

  if (/почему.*(?:ваканси|позици)|чем.*(?:ваканси|позици).*интерес/i.test(prompt)) {
    const role = vacancyTitle.trim() || 'эта позиция';
    const company = vacancyCompany.trim() ? ` в ${vacancyCompany.trim()}` : '';
    return draft(`Мне интересна позиция ${role}${company}: привлекают задачи продукта, зона ответственности и возможность приносить измеримую пользу команде. Перед отправкой уточню формулировку по требованиям конкретной вакансии.`);
  }
  return null;
}
