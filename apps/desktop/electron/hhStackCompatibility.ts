export type HhCoreStack =
  | 'python'
  | 'java'
  | 'javascript_typescript'
  | 'csharp_dotnet'
  | 'swift'
  | 'one_c'
  | 'go'
  | 'kotlin'
  | 'php'
  | 'ruby'
  | 'rust';

export interface HhStackCompatibilityInput {
  searchQuery?: string;
  resumeContext?: string;
  vacancyTitle: string;
  vacancyDescription?: string;
}

export interface HhStackCompatibilityResult {
  compatible: boolean;
  candidateStacks: HhCoreStack[];
  vacancyStacks: HhCoreStack[];
  reason?: string;
}

interface StackDefinition {
  id: HhCoreStack;
  label: string;
  direct: RegExp[];
  frameworks: RegExp[];
  titleOnly?: RegExp[];
}

const STACK_DEFINITIONS: StackDefinition[] = [
  {
    id: 'python',
    label: 'Python',
    direct: [/(?:^|[^\p{L}\p{N}_])python(?:[^\p{L}\p{N}_]|$)/iu, /питон/iu],
    frameworks: [/\bpytest\b/iu, /\blocust\b/iu],
  },
  {
    id: 'java',
    label: 'Java',
    direct: [
      /(?:^|[^\p{L}\p{N}_])java(?!script)(?:[^\p{L}\p{N}_]|$)/iu,
      /(?:^|[^\p{L}\p{N}_])джава(?:[^\p{L}\p{N}_]|$)/iu,
    ],
    frameworks: [/\bjunit\b/iu, /\btestng\b/iu, /\bselenide\b/iu, /\brest\s*assured\b/iu],
  },
  {
    id: 'javascript_typescript',
    label: 'JavaScript/TypeScript',
    direct: [/\bjavascript\b/iu, /\btypescript\b/iu, /\bnode\.?js\b/iu],
    frameworks: [/\bcypress\b/iu, /\bwebdriverio\b/iu, /\bjest\b/iu, /\bmocha\b/iu],
    titleOnly: [/(?:^|[^\p{L}\p{N}_])(?:js|ts)(?:[^\p{L}\p{N}_]|$)/iu],
  },
  {
    id: 'csharp_dotnet',
    label: 'C#/.NET',
    direct: [/(?:^|[^\p{L}\p{N}_])c\s*#(?:[^\p{L}\p{N}_]|$)/iu, /\bcsharp\b/iu, /(?:^|[^\p{L}\p{N}_])\.?net(?:[^\p{L}\p{N}_]|$)/iu, /\bdotnet\b/iu],
    frameworks: [/\bnunit\b/iu],
  },
  {
    id: 'swift',
    label: 'Swift',
    direct: [/(?:^|[^\p{L}\p{N}_])swift(?:[^\p{L}\p{N}_]|$)/iu],
    frameworks: [/\bxctest\b/iu],
  },
  {
    id: 'one_c',
    label: '1C',
    direct: [/(?:^|[^\p{L}\p{N}_])1[сc](?:[^\p{L}\p{N}_]|$)/iu],
    frameworks: [/vanessa\s+automation/iu, /ванесса\s+автоматизац/iu],
  },
  {
    id: 'go',
    label: 'Go',
    direct: [/\bgolang\b/iu, /(?:язык|стек|автотест\w*\s+на|разработ\w*\s+на)\s+go\b/iu],
    frameworks: [],
    titleOnly: [/(?:^|[^\p{L}\p{N}_])go(?:[^\p{L}\p{N}_]|$)/iu],
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    direct: [/\bkotlin\b/iu],
    frameworks: [],
  },
  {
    id: 'php',
    label: 'PHP',
    direct: [/(?:^|[^\p{L}\p{N}_])php(?:[^\p{L}\p{N}_]|$)/iu],
    frameworks: [],
  },
  {
    id: 'ruby',
    label: 'Ruby',
    direct: [/(?:^|[^\p{L}\p{N}_])ruby(?:[^\p{L}\p{N}_]|$)/iu],
    frameworks: [],
  },
  {
    id: 'rust',
    label: 'Rust',
    direct: [/(?:^|[^\p{L}\p{N}_])rust(?:[^\p{L}\p{N}_]|$)/iu],
    frameworks: [],
  },
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function detectDirectStacks(text: string, includeTitleAliases = false): HhCoreStack[] {
  if (!text.trim()) return [];
  return STACK_DEFINITIONS
    .filter((stack) => matchesAny(text, [
      ...stack.direct,
      ...(includeTitleAliases ? stack.titleOnly ?? [] : []),
    ]))
    .map((stack) => stack.id);
}

function detectFrameworkStacks(text: string): HhCoreStack[] {
  if (!text.trim()) return [];
  return STACK_DEFINITIONS
    .filter((stack) => matchesAny(text, stack.frameworks))
    .map((stack) => stack.id);
}

function uniqueStacks(stacks: HhCoreStack[]): HhCoreStack[] {
  const found = new Set(stacks);
  return STACK_DEFINITIONS.map((stack) => stack.id).filter((stack) => found.has(stack));
}

function stackPatterns(stack: StackDefinition, includeTitleAliases: boolean): RegExp[] {
  return [
    ...stack.direct,
    ...stack.frameworks,
    ...(includeTitleAliases ? stack.titleOnly ?? [] : []),
  ];
}

function stackMentionIsNonRequired(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 80), index).replace(/\s+/g, ' ').trimEnd();
  const after = text.slice(index + length, index + length + 80).replace(/\s+/g, ' ').trimStart();
  const nonRequiredBefore = /(?:^|\s)(?:без|не\s+(?:требу[а-яё]*|нуж[а-яё]*|обязател[а-яё]*)|необязател[а-яё]*|опционал[а-яё]*|желател[а-яё]*|optional|not\s+required|nice\s+to\s+have)(?:\s+[\p{L}\p{N}_]+){0,4}\s*$/iu;
  const nonRequiredAfter = /^(?:[,():—–-]+\s*)?(?:не\s+(?:требу[а-яё]*|нуж[а-яё]*|обязател[а-яё]*|основн[а-яё]*)|необязател[а-яё]*|опционал[а-яё]*|(?:is\s+)?optional|not\s+required|будет\s+(?:плюсом|преимуществом)|как\s+(?:плюс|преимущество)|nice\s+to\s+have)/iu;
  return nonRequiredBefore.test(before) || nonRequiredAfter.test(after);
}

function hasRequiredStackMention(
  text: string,
  stack: StackDefinition,
  includeTitleAliases: boolean,
): boolean {
  return stackPatterns(stack, includeTitleAliases).some((pattern) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    for (const match of text.matchAll(matcher)) {
      if (match.index === undefined) continue;
      if (!stackMentionIsNonRequired(text, match.index, match[0].length)) return true;
    }
    return false;
  });
}

function detectRequiredStackMentions(text: string, includeTitleAliases = false): HhCoreStack[] {
  if (!text.trim()) return [];
  return STACK_DEFINITIONS
    .filter((stack) => hasRequiredStackMention(text, stack, includeTitleAliases))
    .map((stack) => stack.id);
}

const DESCRIPTION_CORE_STACK_PATTERNS = [
  /основн[а-яё]*\s+(?:стек|язык)/iu,
  /(?:core|primary|automation)\s+(?:stack|language)/iu,
  /(?:стек|язык)[а-яё]*\s+(?:автоматизац|автотест)/iu,
  /(?:автотест|автоматизац)[а-яё]*.{0,40}(?:стек|язык|пиш|разработ|реализ|\bна\b)/iu,
  /(?:tests?|autotests?).{0,35}(?:written|write|implemented).{0,20}(?:in|with)/iu,
];

const DESCRIPTION_STACK_REQUIREMENT_PATTERNS = [
  /(?:обязател[а-яё]*|требу[а-яё]*|нуж(?:ен|ны)|must|required).{0,60}(?:опыт|знан|владен|умение|навык|стек|язык|автотест)/iu,
  /(?:опыт|знан|владен|умение|навык).{0,60}(?:обязател[а-яё]*|требу[а-яё]*|must|required)/iu,
];

function descriptionClauseDeclaresCoreStack(clause: string): boolean {
  return matchesAny(clause, DESCRIPTION_CORE_STACK_PATTERNS);
}

function detectExplicitDescriptionStacks(description: string): HhCoreStack[] {
  if (!description.trim()) return [];
  const declared: HhCoreStack[] = [];
  for (const clause of description.split(/(?:\r?\n)+|[.!?;•]+/u)) {
    if (descriptionClauseDeclaresCoreStack(clause)) {
      declared.push(...detectRequiredStackMentions(clause));
      continue;
    }
    // Keep a product-language statement separate from a later generic
    // requirement in the same sentence ("backend Java, нужен опыт API").
    const requirementFragments = clause.split(
      /,\s*|\s+(?:и|and)\s+(?=(?:требу[а-яё]*|нуж[а-яё]*|обязател[а-яё]*|required|must))/iu,
    );
    for (const fragment of requirementFragments) {
      if (!matchesAny(fragment, DESCRIPTION_STACK_REQUIREMENT_PATTERNS)) continue;
      declared.push(...detectRequiredStackMentions(fragment));
    }
  }
  return uniqueStacks(declared);
}

function inferResumeStacks(resumeContext: string): HhCoreStack[] {
  const resume = resumeContext.trim();
  if (!resume) return [];

  // Browser assistant prepends the selected HH resume title to the downloaded
  // resume body. A stack named in that title is much stronger evidence than a
  // technology merely mentioned in a project description.
  const headline = resume.split(/\r?\n/, 1)[0] ?? '';
  const headlineStacks = uniqueStacks([
    ...detectDirectStacks(headline, true),
    ...detectFrameworkStacks(headline),
  ]);
  if (headlineStacks.length > 0) return headlineStacks;

  // Frameworks with one canonical implementation language are also strong
  // evidence (Pytest -> Python, JUnit/Selenide -> Java, NUnit -> C#, etc.).
  const frameworkStacks = detectFrameworkStacks(resume);
  if (frameworkStacks.length > 0) return uniqueStacks(frameworkStacks);

  // A single language in the whole resume is unambiguous. Several unrelated
  // language mentions without a title/framework signal are not enough to call
  // any of them the candidate's primary automation stack.
  const directStacks = detectDirectStacks(resume);
  return directStacks.length === 1 ? directStacks : [];
}

/**
 * Infers the automation stack selected for this search. An explicit stack in
 * the query and a known resume stack must agree; a stale/mismatched selected
 * resume therefore fails closed instead of borrowing experience from another
 * search direction.
 */
export function inferHhPrimaryStacks(
  searchQuery = '',
  resumeContext = '',
): HhCoreStack[] {
  const queryStacks = uniqueStacks([
    ...detectDirectStacks(searchQuery, true),
    ...detectFrameworkStacks(searchQuery),
  ]);
  const resumeStacks = inferResumeStacks(resumeContext);
  if (queryStacks.length === 0) return resumeStacks;
  if (resumeStacks.length === 0) return queryStacks;
  return queryStacks.filter((stack) => resumeStacks.includes(stack));
}

function detectVacancyStacks(title: string, description: string): HhCoreStack[] {
  const descriptionStacks = detectExplicitDescriptionStacks(description);
  // The detailed vacancy body is authoritative when it explicitly declares
  // the automation language. This lets "Java" in a short title be clarified
  // by "Java or Python" in the requirements without weakening Java-only jobs.
  if (descriptionStacks.length > 0) return descriptionStacks;
  return uniqueStacks(detectRequiredStackMentions(title, true));
}

function stackLabels(stacks: HhCoreStack[]): string {
  const selected = new Set(stacks);
  return STACK_DEFINITIONS
    .filter((stack) => selected.has(stack.id))
    .map((stack) => stack.label)
    .join(', ');
}

/**
 * Blocks only vacancies with an explicit, recognised core stack that has no
 * overlap with the selected search/resume stack. A generic vacancy without a
 * declared implementation language remains eligible for the existing QA and
 * schedule checks. Mixed alternatives such as "Java or Python" are allowed
 * when at least one alternative matches.
 */
export function evaluateHhStackCompatibility(
  input: HhStackCompatibilityInput,
): HhStackCompatibilityResult {
  const candidateStacks = inferHhPrimaryStacks(
    input.searchQuery ?? '',
    input.resumeContext ?? '',
  );
  const vacancyStacks = detectVacancyStacks(
    input.vacancyTitle,
    input.vacancyDescription ?? '',
  );
  if (vacancyStacks.length === 0) {
    return { compatible: true, candidateStacks, vacancyStacks };
  }

  const compatible = candidateStacks.some((stack) => vacancyStacks.includes(stack));
  if (compatible) return { compatible, candidateStacks, vacancyStacks };

  const selected = candidateStacks.length > 0
    ? stackLabels(candidateStacks)
    : 'не определён в выбранном резюме';
  return {
    compatible: false,
    candidateStacks,
    vacancyStacks,
    reason: `Основной стек вакансии (${stackLabels(vacancyStacks)}) не совпадает с выбранным стеком (${selected}).`,
  };
}

export function isHhStackCompatible(input: HhStackCompatibilityInput): boolean {
  return evaluateHhStackCompatibility(input).compatible;
}
