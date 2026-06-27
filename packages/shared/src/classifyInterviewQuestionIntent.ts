export type QuestionIntent =
  | 'experience'
  | 'technical_definition'
  | 'technical_list'
  | 'technical_comparison'
  | 'practical_usage'
  | 'behavioral'
  | 'unclear';

export type ResumeContextLevel = 'full' | 'limited' | 'none';

export type CorrectionConfidence = 'high' | 'medium' | 'low';

export interface ClassifyQuestionIntentInput {
  question: string;
  rawQuestion?: string;
  glossaryCorrected?: string;
  intentChanged?: boolean;
  intentConfidence?: string;
  correctionMaxConfidence?: CorrectionConfidence | 'none';
  ambiguity?: string;
}

export interface AnswerStrategyResult {
  questionIntent: QuestionIntent;
  answerStrategy: string;
  resumeContextUsed: boolean;
  resumeContextLevel: ResumeContextLevel;
  resumeContextReason: string;
  suggestUnclearPrefix: boolean;
}

const BEHAVIORAL_RE =
  /(?:почему\s+(?:уш\w*|уход|хот\w*\s+(?:работать|сменить|уйти))|конфликт|сильн\w+\s+сторон|слаб\w+\s+сторон|мотивац|куда\s+видишь\s+себя|tell\s+me\s+about\s+yourself)/iu;

const EXPERIENCE_RE =
  /(?:расскаж\w*\s+(?:про|о)\s+(?:сво\w+\s+)?опыт|(?:ваш|твой|свой)\s+опыт|опыт\s+(?:автоматизац|работ|тестир)|на\s+каких\s+проектах|чем\s+занимал\w*\s+на\s+(?:проект|работ)|расскаж\w*\s+о\s+(?:сво\w+\s+)?(?:работ|карьер|проект))/iu;

const PRACTICAL_RE =
  /(?:как\s+ты\s+(?:применял\w*|использовал\w*|настраивал\w*|проверял\w*|запускал\w*|работал\w*|делал\w*|писал\w*)|ты\s+сам\w*\s+(?:настраивал\w*|делал\w*|писал\w*|использовал\w*|настраивал\w*)|сам\s+настраивал\w*|как\s+вы\s+(?:применял\w*|использовал\w*|настраивал\w*)|в\s+работ\w*|на\s+проект\w*)/iu;

const COMPARISON_RE =
  /(?:чем\s+.+\s+отлича|разниц\w*|в\s+ч(?:е|ё)м\s+разниц|\bvs\.?\b|против\s+)/iu;

const LIST_RE =
  /(?:какие\s+(?:бывают\s+)?|перечисли|назови|какие\s+\w+\s+ты\s+знаешь|какие\s+тип\w+|какие\s+вид\w+|какие\s+ошибк\w+|основные\s+\w+\s+(?:групп|тип|вид)|список\s+)/iu;

const DEFINITION_RE =
  /(?:что\s+такое|что\s+значит|что\s+это\s+за|объясни(?:те)?|расскаж\w*\s+что\s+такое|определени\w*)/iu;

const ANSWER_FORMAT =
  '4–7 sentences (~90–150 words), natural first-person spoken style — like a strong candidate, not a textbook. ' +
  'First sentence = direct answer. For a long list, group it by dimensions when natural ' +
  '(e.g. «по уровню», «по цели», «по способу выполнения») and use bullets for 3+ items/steps. ' +
  'No filler openings. Where it fits naturally, add a short personal bridge from the resume ' +
  '(1–2 sentences, real facts only) — e.g. «У меня основной фокус был на…, в Сбере и ГЕОМИКС я…». ' +
  'You MAY finish with at most one optional offer to expand («Если хотите, могу подробнее разложить, как…»).';

const STRATEGY_BY_INTENT: Record<QuestionIntent, Omit<AnswerStrategyResult, 'questionIntent'>> = {
  experience: {
    answerStrategy:
      `Use resume fully. ${ANSWER_FORMAT} Bullets: role, stack, concrete impact. Answer directly, no diagnostic intro.`,
    resumeContextUsed: true,
    resumeContextLevel: 'full',
    resumeContextReason: 'Question asks about candidate experience.',
    suggestUnclearPrefix: false,
  },
  practical_usage: {
    answerStrategy:
      `${ANSWER_FORMAT} Resume only for asked tech: scope, how applied, honest limits. No full resume dump. Answer directly.`,
    resumeContextUsed: true,
    resumeContextLevel: 'full',
    resumeContextReason: 'Question asks how the candidate applied or configured a tool at work.',
    suggestUnclearPrefix: false,
  },
  technical_definition: {
    answerStrategy:
      `${ANSWER_FORMAT} Thesis = definition. Bullets = purpose, key details, max one experience line.`,
    resumeContextUsed: false,
    resumeContextLevel: 'limited',
    resumeContextReason: 'Theory question — resume only as optional one-sentence example.',
    suggestUnclearPrefix: false,
  },
  technical_list: {
    answerStrategy:
      `${ANSWER_FORMAT} Bullets MUST name specific items/anti-patterns by name. ` +
      'Where natural, bridge to a brief personal experience line (which of these the candidate actually used and where) — never a full resume dump. No diagnostic intro — start with the topic.',
    resumeContextUsed: true,
    resumeContextLevel: 'limited',
    resumeContextReason: 'List/theory question — name the items, then a short personal experience bridge where it fits.',
    suggestUnclearPrefix: false,
  },
  technical_comparison: {
    answerStrategy:
      `${ANSWER_FORMAT} Thesis = main difference. Bullets = when to use each, optional QA example.`,
    resumeContextUsed: false,
    resumeContextLevel: 'limited',
    resumeContextReason: 'Comparison question — experience only if usage is implied.',
    suggestUnclearPrefix: false,
  },
  behavioral: {
    answerStrategy:
      `${ANSWER_FORMAT} Bullets: situation, actions, outcome. Answer directly.`,
    resumeContextUsed: false,
    resumeContextLevel: 'none',
    resumeContextReason: 'Behavioral question — no technical resume dump.',
    suggestUnclearPrefix: false,
  },
  unclear: {
    answerStrategy:
      `${ANSWER_FORMAT} Answer the most likely corrected topic directly. If truly unknown, cautious generic thesis.`,
    resumeContextUsed: false,
    resumeContextLevel: 'none',
    resumeContextReason: 'Unclear transcript — answer probable topic without diagnostics.',
    suggestUnclearPrefix: false,
  },
};

function normalizeForMatch(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function shouldSuggestUnclearPrefix(input: {
  questionIntent: QuestionIntent;
  intentConfidence?: string;
  correctionMaxConfidence?: CorrectionConfidence | 'none';
  ambiguity?: string;
  rawQuestion?: string;
  glossaryCorrected?: string;
  question?: string;
}): boolean {
  if (input.questionIntent === 'unclear') return true;
  if (input.intentConfidence === 'low') return true;
  if (input.correctionMaxConfidence === 'low') return true;
  if (input.ambiguity?.trim()) return true;

  const raw = normalizeForMatch(input.rawQuestion ?? '');
  const corrected = normalizeForMatch(input.glossaryCorrected ?? input.question ?? '');
  if (raw && corrected && raw !== corrected) {
    const conf = input.correctionMaxConfidence ?? input.intentConfidence;
    return conf === 'low';
  }
  return false;
}

export function classifyInterviewQuestionIntent(
  input: ClassifyQuestionIntentInput,
): AnswerStrategyResult {
  const question = (input.question || '').trim();
  const q = normalizeForMatch(question);

  if (!q) {
    return { questionIntent: 'unclear', ...STRATEGY_BY_INTENT.unclear };
  }

  let intent: QuestionIntent = 'unclear';

  if (BEHAVIORAL_RE.test(question)) {
    intent = 'behavioral';
  } else if (EXPERIENCE_RE.test(question)) {
    intent = 'experience';
  } else if (PRACTICAL_RE.test(question) && !DEFINITION_RE.test(question)) {
    intent = 'practical_usage';
  } else if (COMPARISON_RE.test(question)) {
    intent = 'technical_comparison';
  } else if (LIST_RE.test(question)) {
    intent = 'technical_list';
  } else if (DEFINITION_RE.test(question)) {
    intent = 'technical_definition';
  } else if (input.intentConfidence === 'low') {
    intent = 'unclear';
  }

  const base = { questionIntent: intent, ...STRATEGY_BY_INTENT[intent] };
  return {
    ...base,
    suggestUnclearPrefix: false,
  };
}

export function getAnswerStrategyForIntent(intent: QuestionIntent): AnswerStrategyResult {
  return { questionIntent: intent, ...STRATEGY_BY_INTENT[intent] };
}
