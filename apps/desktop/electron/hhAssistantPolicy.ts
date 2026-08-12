export interface HhAssistantConfig {
  platform: 'hh' | 'linkedin' | 'avito';
  query: string;
  includeRelatedQueries: boolean;
  additionalQueries: string[];
  area: string;
  experience: string;
  employment: string;
  schedule: string;
  salaryFrom: number | null;
  onlyWithSalary: boolean;
  excludedKeywords: string[];
  excludedEmployers: string[];
  maxQueueSize: number;
  maxPages: number;
  coverLetterTemplate: string;
  autoSend: boolean;
  resumeTitleContains: string;
  resumeTitles: string[];
  delayBetweenSec: number;
  dailyLimit: number;
  autoRunDaily: boolean;
  autoRunHour: number;
  linkedinLocation: string;
  linkedinEasyApplyOnly: boolean;
  avitoCity: string;
}

export interface HhVacancy {
  key?: string;
  platform?: 'hh' | 'linkedin' | 'avito';
  id: string;
  title: string;
  company: string;
  salary: string;
  url: string;
}

function resumeRoleTokens(value: string): Set<string> {
  const normalized = value
    .toLocaleLowerCase('ru')
    .replace(/full[\s-]?stack|фулл[\s-]?ст[еэ]к/g, ' fullstack ')
    .replace(/c\s*#|csharp|\.net|dotnet/g, ' csharp ')
    .replace(/(?:^|\W)(?:aqa|sdet)(?:\W|$)|quality assurance|тестиров\w*|автотест\w*/g, ' qa ')
    .replace(/автоматизац\w*/g, ' automation ')
    .replace(/разработ\w*|программист\w*|software engineer/g, ' developer ')
    .replace(/игр\w*|gamedev/g, ' game ');
  return new Set(
    normalized
      .split(/[^a-zа-я0-9+#.]+/i)
      .filter((token) => token.length > 1),
  );
}

/**
 * Ranks every HH résumé for one vacancy. The configured résumé is only a
 * tie-breaker: a Fullstack vacancy can therefore use a Fullstack résumé even
 * when the user's default search direction is QA.
 */
export function rankHhResumeTitlesForVacancy(
  vacancyTitle: string,
  resumeTitles: string[],
  defaultTitles: string[] = [],
): string[] {
  const vacancyTokens = resumeRoleTokens(vacancyTitle);
  const defaults = new Set(defaultTitles.map((title) => title.toLocaleLowerCase('ru').trim()));
  const vacancyIsQa = vacancyTokens.has('qa');
  const vacancyIsDeveloper = vacancyTokens.has('developer') || vacancyTokens.has('game');
  return resumeTitles
    .map((title, index) => {
      const resumeTokens = resumeRoleTokens(title);
      let score = defaults.has(title.toLocaleLowerCase('ru').trim()) ? 1 : 0;
      for (const token of resumeTokens) {
        if (vacancyTokens.has(token)) score += ['qa', 'developer', 'game', 'fullstack'].includes(token) ? 12 : 5;
      }
      const resumeIsQa = resumeTokens.has('qa');
      const resumeIsDeveloper = resumeTokens.has('developer') || resumeTokens.has('game') || resumeTokens.has('fullstack');
      if (vacancyIsQa && resumeIsQa) score += 20;
      if (vacancyIsDeveloper && resumeIsDeveloper) score += 20;
      if (vacancyIsQa && resumeIsDeveloper && !resumeIsQa) score -= 12;
      if (vacancyIsDeveloper && resumeIsQa && !resumeIsDeveloper) score -= 12;
      return { title, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ title }) => title);
}

export const DEFAULT_HH_ASSISTANT_CONFIG: HhAssistantConfig = {
  platform: 'hh',
  query: '',
  includeRelatedQueries: true,
  additionalQueries: [],
  area: '',
  experience: '',
  employment: '',
  schedule: 'remote',
  salaryFrom: null,
  onlyWithSalary: false,
  excludedKeywords: [],
  excludedEmployers: [],
  maxQueueSize: 500,
  maxPages: 20,
  coverLetterTemplate:
    'Здравствуйте! Меня заинтересовала вакансия «{vacancy}» в {company}. ' +
    'Буду рад обсудить мой релевантный опыт и задачи команды на интервью.',
  autoSend: true,
  resumeTitleContains: '',
  resumeTitles: [],
  delayBetweenSec: 20,
  dailyLimit: 20,
  autoRunDaily: false,
  autoRunHour: 10,
  linkedinLocation: '',
  linkedinEasyApplyOnly: true,
  avitoCity: 'all',
};

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    const item = String(raw ?? '').trim().slice(0, 120);
    const key = item.toLocaleLowerCase('ru');
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= 30) break;
  }
  return result;
}

export function normalizeHhAssistantConfig(
  value: Partial<HhAssistantConfig> | null | undefined,
): HhAssistantConfig {
  const source = value ?? {};
  const salary = Number(source.salaryFrom);
  return {
    platform: source.platform === 'linkedin' || source.platform === 'avito' ? source.platform : 'hh',
    query: String(source.query ?? '').trim().slice(0, 200),
    includeRelatedQueries: source.includeRelatedQueries !== false,
    additionalQueries: cleanList(source.additionalQueries).slice(0, 8),
    area: String(source.area ?? DEFAULT_HH_ASSISTANT_CONFIG.area).trim().slice(0, 20),
    experience: String(source.experience ?? '').trim().slice(0, 40),
    employment: String(
      source.employment ?? DEFAULT_HH_ASSISTANT_CONFIG.employment,
    ).trim().slice(0, 40),
    schedule: String(
      source.schedule ?? DEFAULT_HH_ASSISTANT_CONFIG.schedule,
    ).trim().slice(0, 40),
    salaryFrom:
      Number.isFinite(salary) && salary > 0
        ? boundedInt(salary, 0, 1, 10_000_000)
        : null,
    onlyWithSalary: Boolean(source.onlyWithSalary),
    excludedKeywords: cleanList(source.excludedKeywords),
    excludedEmployers: cleanList(source.excludedEmployers),
    maxQueueSize: boundedInt(source.maxQueueSize, 500, 20, 500),
    maxPages: boundedInt(source.maxPages, 20, 1, 20),
    coverLetterTemplate:
      String(
        source.coverLetterTemplate ?? DEFAULT_HH_ASSISTANT_CONFIG.coverLetterTemplate,
      ).trim().slice(0, 4000) || DEFAULT_HH_ASSISTANT_CONFIG.coverLetterTemplate,
    autoSend: source.autoSend !== undefined
      ? Boolean(source.autoSend)
      : DEFAULT_HH_ASSISTANT_CONFIG.autoSend,
    resumeTitleContains: String(source.resumeTitleContains ?? '').trim().slice(0, 200),
    resumeTitles: cleanList(source.resumeTitles),
    delayBetweenSec: boundedInt(source.delayBetweenSec, 20, 5, 120),
    dailyLimit: boundedInt(source.dailyLimit, DEFAULT_HH_ASSISTANT_CONFIG.dailyLimit, 1, 200),
    autoRunDaily: source.autoRunDaily !== undefined
      ? Boolean(source.autoRunDaily)
      : DEFAULT_HH_ASSISTANT_CONFIG.autoRunDaily,
    autoRunHour: boundedInt(source.autoRunHour, 10, 0, 23),
    linkedinLocation: String(source.linkedinLocation ?? '').trim().slice(0, 120),
    linkedinEasyApplyOnly: source.linkedinEasyApplyOnly !== false,
    avitoCity: /^[a-z0-9_-]{2,40}$/i.test(String(source.avitoCity ?? 'all'))
      ? String(source.avitoCity ?? 'all').toLocaleLowerCase('en-US')
      : 'all',
  };
}

function rememberSearchQuery(target: string[], seen: Set<string>, value: string): void {
  const query = value.replace(/\s+/g, ' ').trim().slice(0, 200);
  const key = query.toLocaleLowerCase('ru');
  if (!query || seen.has(key) || target.length >= 20) return;
  seen.add(key);
  target.push(query);
}

type QaSearchProfile = 'not_qa' | 'manual' | 'automation';

const QA_INTENT_RE = /(?:^|\W)(?:qa|aqa|sdet)(?:\W|$)|quality assurance|тестир|автотест/i;
const EXPLICIT_AUTOMATION_RE =
  /(?:^|\W)(?:aqa|sdet)(?:\W|$)|qa\s+automation|automation\s+qa|автоматизатор|автоматизац\S*\s+тест|автотест/i;
const EXPLICIT_MANUAL_RE =
  /manual\s+qa|qa\s+manual|ручн\S*\s+тест|мануальн\S*\s+тест/i;

/**
 * A broad "QA engineer" title is not an automation role by itself. Infer
 * automation only from an explicit search request or strong evidence in the
 * selected resume; otherwise fail closed to manual QA.
 */
export function detectQaSearchProfile(query: string, resumeContext = ''): QaSearchProfile {
  const normalizedQuery = query.toLocaleLowerCase('ru');
  if (!QA_INTENT_RE.test(normalizedQuery)) return 'not_qa';
  if (EXPLICIT_MANUAL_RE.test(normalizedQuery)) return 'manual';
  if (EXPLICIT_AUTOMATION_RE.test(normalizedQuery)) return 'automation';

  const resume = resumeContext.toLocaleLowerCase('ru');
  if (EXPLICIT_MANUAL_RE.test(resume) && !EXPLICIT_AUTOMATION_RE.test(resume)) return 'manual';
  if (EXPLICIT_AUTOMATION_RE.test(resume)) return 'automation';

  const automationTools = [
    /(?:^|\W)pytest(?:\W|$)/i,
    /(?:^|\W)playwright(?:\W|$)/i,
    /(?:^|\W)selenium(?:\W|$)/i,
    /(?:^|\W)cypress(?:\W|$)/i,
    /(?:^|\W)appium(?:\W|$)/i,
    /(?:^|\W)(?:junit|testng|rest\s*assured)(?:\W|$)/i,
  ];
  const toolCount = automationTools.filter((pattern) => pattern.test(resume)).length;
  const writesAutomatedTests =
    /(?:писал|разрабатывал|создавал|поддерживал|внедрял|writing|developed|maintained)\S*(?:[^.\n]{0,60})(?:автотест|automated test|test automation)/i.test(resume);
  return writesAutomatedTests || toolCount >= 2 ? 'automation' : 'manual';
}

/**
 * HH interprets a multi-word query quite literally. A person searching for
 * "QA FULLSTACK PYTHON" should therefore also see the same role advertised as
 * AQA, SDET, QA Automation, or an automation-test engineer. Keep expansion
 * conservative: it may rephrase a role, but must not invent another profession.
 */
export function buildHhSearchQueries(config: HhAssistantConfig, resumeContext = ''): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const base = config.query.replace(/\s+/g, ' ').trim();
  rememberSearchQuery(queries, seen, base);

  if (config.includeRelatedQueries) {
    const normalized = base.toLocaleLowerCase('ru');
    const qaProfile = detectQaSearchProfile(base, resumeContext);
    const isPython = /(?:^|\W)python(?:\W|$)|питон/i.test(normalized);
    const isFullstack = /full[\s-]?stack|фулл[\s-]?ст[еэ]к/i.test(normalized);

    if (qaProfile === 'automation' && isPython) {
      rememberSearchQuery(queries, seen, 'QA Automation Python');
      rememberSearchQuery(queries, seen, 'AQA Python');
      rememberSearchQuery(queries, seen, 'SDET Python');
      rememberSearchQuery(queries, seen, 'инженер по автоматизации тестирования Python');
      if (isFullstack) rememberSearchQuery(queries, seen, 'Fullstack QA Python');
      // HH does not treat close role names as synonyms. Keep several precise
      // formulations so a generic title such as "Тестировщик-автоматизатор / QA"
      // is still found when Python appears only inside the description.
      rememberSearchQuery(queries, seen, 'тестировщик-автоматизатор Python');
      rememberSearchQuery(queries, seen, 'автоматизация тестирования Python');
      rememberSearchQuery(queries, seen, 'Python QA');
      rememberSearchQuery(queries, seen, 'QA Engineer Python');
    } else if (qaProfile === 'automation') {
      rememberSearchQuery(queries, seen, 'QA Automation');
      rememberSearchQuery(queries, seen, 'AQA');
      rememberSearchQuery(queries, seen, 'SDET');
      rememberSearchQuery(queries, seen, 'инженер по автоматизации тестирования');
    } else if (qaProfile === 'manual') {
      rememberSearchQuery(queries, seen, 'Manual QA');
      rememberSearchQuery(queries, seen, 'QA Engineer');
      rememberSearchQuery(queries, seen, 'тестировщик');
      rememberSearchQuery(queries, seen, 'инженер по тестированию');
    }
  }

  for (const query of config.additionalQueries) rememberSearchQuery(queries, seen, query);
  return queries;
}

/**
 * HH searches descriptions as well as titles, so a QA query can otherwise
 * return a business analyst or DevOps vacancy that merely mentions testing.
 * Apply a profession-level title guard for recognised intents. Unknown queries
 * keep HH's own ranking, while explicit developer directions get their own
 * developer guard instead of being mixed into QA.
 */
export function isVacancyRelevantToSearchQuery(vacancy: HhVacancy, query: string): boolean {
  const normalizedQuery = query.toLocaleLowerCase('ru');
  const title = vacancy.title.toLocaleLowerCase('ru');
  const qaIntent = /(?:^|\W)(?:qa|aqa|sdet)(?:\W|$)|тестир|автотест/i.test(normalizedQuery);
  if (qaIntent) {
    const developerQaTitle =
      /(?:^|\W)(?:qa|aqa|sdet)(?:\W|$)|qa\s+automation|automation\s+qa|автотест/i.test(title);
    const dataQualityTitle = /data\s+quality\s+assurance|качест\w*\s+данн/i.test(title);
    const developerLedTitle = /^(?:разработчик|developer|software engineer|devops)(?:\W|$)/i.test(title);
    if (dataQualityTitle && !/(?:^|\W)(?:qa|aqa|sdet)(?:\W|$)|автотест|тестиров/i.test(title)) return false;
    if (developerLedTitle && !developerQaTitle) return false;
    const qaTitle = /(?:^|\W)(?:qa|aqa|sdet)(?:\W|$)|quality assurance|тестир|автотест/i.test(title);
    const strongQaTitle = /(?:^|\W)(?:aqa|sdet)(?:\W|$)|quality assurance|тестир|автотест|qa\s+automation|automation\s+qa/i.test(title);
    const developerTitle = /developer|разработчик|программист|software engineer|devops/i.test(title);
    return qaTitle && (!developerTitle || strongQaTitle);
  }

  const developerIntent = /developer|разработ|программист|game|unity|unreal|игр/i.test(normalizedQuery);
  if (developerIntent) {
    return /developer|разработ|программист|software engineer|full[\s-]?stack|backend|frontend|unity|unreal|game/i.test(title);
  }

  return true;
}

/**
 * Validates recommendation cards against the complete search direction. HH's
 * home feed often shows a generic QA title and keeps Python/automation only in
 * the vacancy body, so title-only filtering would either miss it or admit every
 * manual-QA role. Search result pages already apply the query to descriptions;
 * this stricter check is for cards collected outside those result pages.
 */
export function isVacancyRelevantToSearchProfile(
  vacancy: HhVacancy,
  query: string,
  description = '',
  resumeContext = '',
): boolean {
  if (!isVacancyRelevantToSearchQuery(vacancy, query)) return false;
  const normalizedQuery = query.toLocaleLowerCase('ru');
  const candidate = `${vacancy.title}\n${description}`.toLocaleLowerCase('ru');
  const pythonIntent = /(?:^|\W)python(?:\W|$)|питон/i.test(normalizedQuery);
  if (pythonIntent && !/(?:^|\W)python(?:\W|$)|питон/i.test(candidate)) return false;

  const qaProfile = detectQaSearchProfile(query, resumeContext);
  if (qaProfile === 'automation') {
    const automationEvidence =
      /(?:^|\W)(?:aqa|sdet)(?:\W|$)|automation|автоматиз|автотест|pytest|playwright|selenium|locust|jmeter|(?:^|\W)k6(?:\W|$)|нагрузочн\S*\s+тест/i.test(candidate);
    if (!automationEvidence) return false;
  }
  if (qaProfile === 'manual') {
    const title = vacancy.title.toLocaleLowerCase('ru');
    const specialisedTitle =
      /(?:^|\W)(?:aqa|sdet)(?:\W|$)|qa\s+automation|automation\s+qa|автоматизатор|автотест|data\s+(?:qa|quality)|(?:qa|quality)\s+data|нагрузочн\S*\s+тест|performance\s+(?:qa|test)|(?:qa|test)\s+performance/i.test(title);
    if (specialisedTitle) return false;

    // Generic "QA Engineer" titles are checked again after the vacancy body
    // is loaded. Do not admit a role whose actual responsibility is writing
    // automated tests merely because the title itself is broad.
    const automationResponsibility =
      /(?:разработ|писать|написан|созда|поддерж|внедр)\S*(?:[^.\n]{0,70})(?:автотест|автоматизац\S*\s+тест)|(?:develop|write|maintain|implement)\S*(?:[^.\n]{0,70})(?:automated test|test automation)/i.test(candidate);
    const automationStack = [
      /(?:^|\W)pytest(?:\W|$)/i,
      /(?:^|\W)playwright(?:\W|$)/i,
      /(?:^|\W)selenium(?:\W|$)/i,
      /(?:^|\W)cypress(?:\W|$)/i,
      /(?:^|\W)appium(?:\W|$)/i,
      /(?:^|\W)(?:junit|testng|rest\s*assured)(?:\W|$)/i,
    ].filter((pattern) => pattern.test(candidate)).length;
    if (description && (automationResponsibility || automationStack >= 2)) return false;
  }
  return true;
}

/**
 * Recommendation cards do not inherit filters from /search/vacancy. For a
 * remote preference, missing format data is not a rejection: only an explicit
 * office-only requirement is blocked. HH often keeps the actual work format
 * outside the vacancy description.
 */
export function isVacancyCompatibleWithSearchSchedule(
  vacancy: HhVacancy,
  schedule: string,
  description = '',
): boolean {
  if (schedule !== 'remote') return true;
  const candidate = `${vacancy.title}\n${description}`.toLocaleLowerCase('ru');
  if (/remote|удал[её]н|дистанцион|из любой точки|работа из дома/i.test(candidate)) {
    return true;
  }
  const titleIsOfficeOnly = /(?:^|[\s([])(?:в офис|офис\s+(?:в|на)|офисн(?:ая|ый|ое) работ|on[ -]?site)(?:[\s),]|$)/i
    .test(vacancy.title);
  const formatIsOfficeOnly = /формат работы\s*:\s*на месте работодателя(?![^\n.]{0,80}(?:или\s+удал|удал[её]н|remote))/i
    .test(candidate);
  const explicitOfficeOnly = /(?:только|исключительно)\s+(?:в\s+)?офис|работа\s+(?:только|исключительно)\s+из\s+офиса/i
    .test(candidate);
  return !titleIsOfficeOnly && !formatIsOfficeOnly && !explicitOfficeOnly;
}

export function buildHhSearchUrl(config: HhAssistantConfig, page = 0): string {
  const url = new URL('https://hh.ru/search/vacancy');
  if (config.query) url.searchParams.set('text', config.query);
  url.searchParams.append('search_field', 'name');
  url.searchParams.append('search_field', 'company_name');
  url.searchParams.append('search_field', 'description');
  url.searchParams.set('enable_snippets', 'true');
  url.searchParams.set('L_save_area', 'true');
  if (config.area) url.searchParams.set('area', config.area);
  if (config.experience) url.searchParams.set('experience', config.experience);
  if (config.employment) url.searchParams.set('employment', config.employment);
  if (config.schedule) url.searchParams.set('schedule', config.schedule);
  if (config.salaryFrom) url.searchParams.set('salary', String(config.salaryFrom));
  if (config.onlyWithSalary) url.searchParams.set('only_with_salary', 'true');
  url.searchParams.set('order_by', 'publication_time');
  url.searchParams.set('page', String(Math.max(0, Math.round(page))));
  return url.toString();
}

export function normalizeHhVacancyUrl(raw: string): string {
  try {
    const url = new URL(raw, 'https://hh.ru');
    const host = url.hostname.toLocaleLowerCase('en-US');
    if (url.protocol !== 'https:' || (host !== 'hh.ru' && !host.endsWith('.hh.ru'))) {
      return '';
    }
    const responseVacancyId = url.pathname === '/applicant/vacancy_response'
      ? url.searchParams.get('vacancyId')?.trim() ?? ''
      : '';
    if (responseVacancyId && /^\d+$/.test(responseVacancyId)) {
      url.pathname = `/vacancy/${responseVacancyId}`;
    }
    if (!/^\/vacancy\/\d+\/?$/.test(url.pathname)) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '');
    return url.toString();
  } catch {
    return '';
  }
}

export function shouldExcludeVacancy(
  vacancy: HhVacancy,
  config: HhAssistantConfig,
): 'excluded_keyword' | 'excluded_employer' | null {
  const title = vacancy.title.toLocaleLowerCase('ru');
  const company = vacancy.company.toLocaleLowerCase('ru');
  if (config.excludedKeywords.some((item) => title.includes(item.toLocaleLowerCase('ru')))) {
    return 'excluded_keyword';
  }
  if (
    config.excludedEmployers.some((item) =>
      company.includes(item.toLocaleLowerCase('ru')),
    )
  ) {
    return 'excluded_employer';
  }
  return null;
}

export function renderCoverLetter(template: string, vacancy: HhVacancy): string {
  return template
    .replaceAll('{vacancy}', vacancy.title)
    .replaceAll('{company}', vacancy.company)
    .trim()
    .slice(0, 4000);
}
