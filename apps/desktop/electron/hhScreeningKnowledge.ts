import {
  matchScreeningOptionLabels,
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

const SALARY_QUESTION_RE = /(?:зарплат|з\s*\/?\s*п\b|оклад|доход|компенсац|денежн|вилк)/i;
const MONEY_RE = /(\d{2,3}(?:[\s\u00a0]\d{3})+|\d{5,7})\s*(?:₽|руб(?:\.|лей|ля)?|rub\b)/giu;
const RELOCATION_RE = /релокац|переезд|переехать|перебраться|сменить\s+(?:город|место\s+жительства)/i;
const FOREIGN_RELOCATION_RE = /за\s+(?:рубеж|границ)|другую\s+стран|саудов|оаэ|эмират|дуба[йе]|кипр|турц|грузи|тбилис|армени|ереван|казахстан|алмат|астан|кыргыз|бишкек|узбекистан|ташкент|серби|белград|черногор|европ|германи|польш|чехи|израил|сша|америк|канад|испан|португал|франц|итал|нидерланд|голланд|бельги|австри|швейцар|швец|норвег|финлянд|дани|великобритан|англи|ирланд|румын|болгар|венгр|хорват|словен|словац|литв|латви|эстон|грец|беларус|белорус|минск|украин|киев|молдов|кишинев|азербайджан|баку|мексик|бразил|аргентин|чили|австрали|нов(?:ую|ая)?\s+зеланд|индонез|таиланд|вьетнам/i;
const RUSSIAN_RELOCATION_RE = /(?:^|[^а-яё])(?:росси|рф(?=$|[^а-яё])|москв|санкт[ -]?петербург|петербург|питер|рязань|йошкар|казан|иннополис|новосибир|екатеринбург|нижн(?:ий|его)\s+новгород|самар|уф[ауе]|перм|омск|челябинск|ростов|краснодар|красноярск|воронеж|волгоград|соч[и]|тюмень|томск|саратов|тольятти|ижевск|барнаул|владивосток|хабаровск|калининград|ярославл|тула|иркутск|ульяновск)/i;

export type ScreeningRelocationScope = 'russia' | 'abroad' | 'unspecified';

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
  const scope = screeningRelocationScope(value);
  return scope === 'russia' || scope === 'abroad'
    ? `preference:relocation:${scope}`
    : screeningQuestionKey(value);
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
      if (/(?:^|[^а-яё])нет(?=$|[^а-яё])|не\s+готов|не\s+рассматрива/.test(value)) score += 8;
      if (/только(?:\s+полностью)?\s+удален|своем\s+городе|без\s+переезд/.test(value)) score += 6;
      if (/но\s+готов.{0,30}(?:приезж|офис)/.test(value)) score -= 5;
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

/** Maps one confirmed preference to a differently worded form question. */
export function reusableScreeningAnswer(
  question: HhScreeningQuestion,
  fact: ConfirmedScreeningFact,
): HhScreeningAnswer | null {
  const exact = screeningQuestionKey(question.prompt) === screeningQuestionKey(fact.question);
  const samePreference = screeningQuestionSemanticKey(question.prompt) === screeningQuestionSemanticKey(fact.question);
  if (!exact && !samePreference) return null;
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
  const intent = screeningPreferenceIntent(fact);
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
  { question: /пользуетесь ли вы LLM/i, option: /^Ежедневно$/i },
  {
    question: /развернуть LLM.*агент/i,
    option: /^Да$/i,
    preparationNote: 'Повторить развёртывание LLM-агента: модель, инструменты, секреты, наблюдаемость и ограничения доступа.',
  },
  { question: /заниматься промт-инжиниринг/i, option: /^Да$/i },
  {
    question: /знаете.*как работают LLM/i,
    option: /^Примерно$/i,
    preparationNote: 'Повторить базовую механику LLM: токенизация, attention, контекст, temperature и ограничения модели.',
  },
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
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, Math.max(0, limit))
    .map(({ fact }) => fact);
}

/** Extracts the desired monthly salary from the explicit setting or HH résumé. */
export function findSalaryExpectation(
  configuredSalary: number | null | undefined,
  sources: string[],
): number | null {
  if (Number.isFinite(configuredSalary) && Number(configuredSalary) >= 30_000) {
    return Math.round(Number(configuredSalary));
  }
  for (const source of sources) {
    MONEY_RE.lastIndex = 0;
    for (const match of source.matchAll(MONEY_RE)) {
      const value = Number((match[1] ?? '').replace(/[\s\u00a0]/g, ''));
      if (Number.isFinite(value) && value >= 30_000 && value <= 10_000_000) return value;
    }
  }
  return null;
}

function formatRubles(value: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)} ₽`;
}

/** Builds the same factual salary answer for HH forms and recruiter chats. */
export function buildSalaryExpectationAnswer(
  salaryExpectation: number,
  question: string,
): string {
  const salary = formatRubles(salaryExpectation);
  const asksForRange = /(?:миним|комфорт|вилк|от\s+и\s+до)/i.test(question);
  return asksForRange
    ? `Минимум — ${salary} на руки; комфортный уровень готов обсудить с учётом задач и общего компенсационного пакета.`
    : `Рассматриваю предложения от ${salary} на руки, итоговый уровень готов обсудить с учётом задач и общего компенсационного пакета.`;
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
  if (!/опыт/i.test(question)) return null;
  const threshold = question.match(/(\d+(?:[.,]\d+)?)\s*(?:год(?:а|ов)?|лет)(?=\s|[?!.,]|$)/i);
  if (!threshold) return null;
  const experienceMonths = findResumeExperienceMonths(resumeText);
  if (experienceMonths == null) return null;
  const thresholdMonths = Math.round(Number(threshold[1].replace(',', '.')) * 12);
  if (!Number.isFinite(thresholdMonths) || thresholdMonths <= 0) return null;
  if (/(?:более|свыше|больше)/i.test(question)) {
    return experienceMonths > thresholdMonths ? 'Да' : 'Нет';
  }
  if (/(?:не\s+менее|минимум|от\s+\d)/i.test(question)) {
    return experienceMonths >= thresholdMonths ? 'Да' : 'Нет';
  }
  return null;
}

function resumeEmployerNames(resumeText: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[•\n])\s*([^\n•]{2,80}?)(?=\d+\s*(?:год|года|лет|месяц|месяца|месяцев))/giu;
  for (const match of resumeText.matchAll(pattern)) {
    const name = String(match[1] ?? '').replace(/\s+/g, ' ').trim();
    const key = name.toLocaleLowerCase('ru');
    if (!name || /опыт работы|добавить/i.test(name) || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= 4) break;
  }
  return names;
}

function resumeAutomationTools(resumeText: string): string[] {
  const candidates: Array<[string, RegExp]> = [
    ['Python', /\bPython\b/i],
    ['Pytest', /\bPytest\b/i],
    ['Playwright', /\bPlaywright\b/i],
    ['Selenium', /\bSelenium\b/i],
    ['HTTPX', /\bHTTPX\b/i],
    ['Requests', /\bRequests\b/i],
  ];
  return candidates.filter(([, pattern]) => pattern.test(resumeText)).map(([name]) => name);
}

/**
 * Deterministic answers for preferences SkillCue already has. These win over
 * the model, so an obvious salary question cannot become a manual blocker.
 */
export function knownScreeningAnswer(
  question: HhScreeningQuestion,
  salaryExpectation: number | null,
  resumeText = '',
  preferences: { remoteOnly?: boolean } = {},
): HhScreeningAnswer | null {
  if (preferences.remoteOnly && screeningRelocationScope(question.prompt) === 'russia') {
    const remoteOnlyFact: ConfirmedScreeningFact = {
      question: 'Рассматриваете ли вы переезд по России ради работы?',
      answer: 'Нет, переезд по России не рассматриваю. Интересует только полностью удалённый формат работы.',
      selectedOptions: ['Нет, рассматриваю только полностью удалённый формат'],
    };
    return reusableScreeningAnswer(question, remoteOnlyFact);
  }
  if (question.kind === 'text' && salaryExpectation && SALARY_QUESTION_RE.test(question.prompt)) {
    return {
      id: question.id,
      answer: buildSalaryExpectationAnswer(salaryExpectation, question.prompt),
      selectedOptions: [],
      canAutoFill: true,
      reason: '',
    };
  }

  if (question.kind !== 'text') {
    const confirmedYes = question.options.find((option) => /^да[.!]?$/i.test(option.trim()));
    const asksAboutCommercialAutomation =
      /(?:практическ|коммерческ).*опыт.*автотест|опыт.*автотест.*(?:python|питон|коммерческ)/i.test(question.prompt);
    const resumeConfirmsCommercialAutomation =
      /автотест/i.test(resumeText) && /\bPython\b/i.test(resumeText) && resumeEmployerNames(resumeText).length > 0;
    const asksAboutWebTesting =
      /опыт.*тестирован.*(?:web|веб)|тестирован.*(?:web|веб).*опыт/i.test(question.prompt);
    const resumeConfirmsWebTesting =
      /(?:web|веб)[-\s]?приложен/i.test(resumeText) && /тестир/i.test(resumeText);
    if (
      confirmedYes
      && ((asksAboutCommercialAutomation && resumeConfirmsCommercialAutomation)
        || (asksAboutWebTesting && resumeConfirmsWebTesting))
    ) {
      return {
        id: question.id,
        answer: '',
        selectedOptions: [confirmedYes],
        canAutoFill: true,
        reason: '',
      };
    }
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

  if (/предстоящ.*обязанност.*заинтересовал|как понимаете предстоящую роль/i.test(question.prompt)) {
    return {
      id: question.id,
      answer: 'Больше всего меня заинтересовали задачи по обеспечению качества продукта, развитию автоматизации и поиску рисков на ранних этапах. Роль понимаю как активное участие в разработке: от анализа требований и тест-дизайна до автотестов, диагностики дефектов и контроля качества релиза.',
      selectedOptions: [], canAutoFill: true, reason: '',
    };
  }
  if (
    /опыт.*тестирован.*(?:web|веб)|тестирован.*(?:web|веб).*опыт/i.test(question.prompt)
    && /(?:web|веб)[-\s]?приложен/i.test(resumeText)
    && /тестир/i.test(resumeText)
  ) {
    const duration = resumeExperienceDuration(resumeText);
    return {
      id: question.id,
      answer: `Да. Есть коммерческий опыт тестирования web-приложений${duration ? ` — ${duration}` : ''}: функциональное, регрессионное, smoke и exploratory-тестирование, а также UI/API-автоматизация.`,
      selectedOptions: [], canAutoFill: true, reason: '',
    };
  }
  if (
    /коммерческ.*опыт.*(?:написан|разработк).*автотест|опыт.*автотест.*коммерческ/i.test(question.prompt)
    && /автотест/i.test(resumeText)
  ) {
    const employers = resumeEmployerNames(resumeText);
    const tools = resumeAutomationTools(resumeText);
    const duration = resumeExperienceDuration(resumeText);
    if (employers.length > 0 && tools.length > 0) {
      return {
        id: question.id,
        answer: `Да. Коммерческий опыт разработки автотестов${duration ? ` — в рамках ${duration} общего опыта` : ''}. Компании: ${employers.join(', ')}. Подтверждённый резюме стек: ${tools.join(', ')}; основной язык — Python.`,
        selectedOptions: [], canAutoFill: true, reason: '',
      };
    }
  }
  if (
    /опыт.*(?:финтех|web3|веб3)|(?:финтех|web3|веб3).*опыт/i.test(question.prompt)
    && /(?:сбер|сбербанк|банк|финтех)/i.test(resumeText)
  ) {
    return {
      id: question.id,
      answer: 'Есть опыт в финтехе: один год работал AQA-инженером на внутреннем корпоративном продукте Сбербанка, автоматизировал UI и API сценарии на Python, Pytest и Playwright. Коммерческого опыта в web3 нет.',
      selectedOptions: [], canAutoFill: true, reason: '',
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
  if (/опыт использования ИИ|используете.*ИИ|какие.*задач.*(?:ИИ|AI)|какие задачи решали.*чем пользовались/i.test(question.prompt)) {
    return {
      id: question.id,
      answer: 'Использую LLM для анализа требований, подготовки тестовых сценариев, поиска граничных случаев, разбора логов и прототипирования автоматизации на Python. Проверяю ответы модели по исходным данным, не передаю секреты и оставляю критичные решения под контролем человека.',
      selectedOptions: [], canAutoFill: true, reason: '',
      preparationNote: 'Подготовить один конкретный пример применения LLM в QA и рассказать, как проверялся результат.',
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

  if (/жанр\s+RTS|RTS.*игр/i.test(prompt)) {
    return draft('Да, жанр RTS мне нравится. На ПК играл в StarCraft II и Age of Empires II: больше всего интересны управление ресурсами, развитие базы и принятие решений в условиях ограниченного времени. На мобильных устройствах в RTS играл заметно меньше.');
  }
  if (/мобильн.*игр.*(?:последн|3\s*месяц)|(?:последн|3\s*месяц).*мобильн.*игр/i.test(prompt)) {
    return draft('За последние три месяца играл в Brawl Stars и Clash Royale. Обращал внимание не только на игровой процесс, но и на подбор соперников, баланс, стабильность сессий и удобство интерфейса.');
  }
  if (/\bMatrix\b|друг.*мессенджер/i.test(prompt)) {
    return draft('С Matrix коммерческого опыта пока не было. Из других мессенджеров использовал Telegram и рабочие командные чаты для коммуникации, уведомлений и координации задач; с устройством Matrix готов быстро разобраться.');
  }
  if (/релокац|переезд/i.test(prompt)) {
    const destination = /саудовск/i.test(prompt) ? 'в Саудовскую Аравию' : 'в указанную локацию';
    const duration = /3\s*месяц/i.test(prompt) ? ' на три месяца' : '';
    return draft(`Да, готов рассмотреть релокацию ${destination}${duration}, если работодатель оплачивает переезд, проживание, визу и медицинскую страховку, а сроки и остальные условия будут заранее согласованы и зафиксированы.`);
  }
  if (/\bИП\b|самозанят|\bСМЗ\b|схем.*оформлен|формат.*оформлен/i.test(prompt)) {
    return draft('Готов рассмотреть работу по ИП или как самозанятый при прозрачном договоре, заранее согласованных налоговых и платёжных условиях и понятном порядке прекращения сотрудничества.');
  }
  if (/почему.*(?:ваканси|позици)|чем.*(?:ваканси|позици).*интерес/i.test(prompt)) {
    const role = vacancyTitle.trim() || 'эта позиция';
    const company = vacancyCompany.trim() ? ` в ${vacancyCompany.trim()}` : '';
    return draft(`Мне интересна позиция ${role}${company}: она сочетает задачи по качеству продукта, развитию автоматизации и работе с техническими рисками. Мой опыт с Python, Pytest, Playwright и API-тестированием позволит быстро включиться в задачи, а новые части стека я готов оперативно освоить.`);
  }

  if (question.kind !== 'text') {
    const isLowRiskExperienceQuestion = /опыт|знаком|работали|использовали/i.test(prompt)
      && !/гражданств|разрешен.*работ|релокац|переезд|зарплат|оклад|график|смен|оформлен|самозанят|ИП\b/i.test(prompt);
    const affirmative = isLowRiskExperienceQuestion
      ? question.options.find((option) => /^(?:да|yes)$/i.test(option.trim()))
      : undefined;
    return affirmative ? draft('', [affirmative]) : null;
  }

  if (/опыт|работали|использовали|знакомы/i.test(prompt)
    && !/гражданств|разрешен.*работ|зарплат|оклад|график|смен|локаци|проживаете/i.test(prompt)) {
    return draft('Прямого коммерческого опыта именно в этом направлении пока не было, но я знаком с основными принципами и смогу быстро углубиться. Близкий опыт в автоматизации тестирования на Python, Pytest и Playwright поможет быстрее разобраться в инструментах и рабочих сценариях.');
  }
  return null;
}
