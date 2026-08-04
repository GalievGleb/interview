export interface HhAssistantConfig {
  query: string;
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
}

export interface HhVacancy {
  id: string;
  title: string;
  company: string;
  salary: string;
  url: string;
}

export const DEFAULT_HH_ASSISTANT_CONFIG: HhAssistantConfig = {
  query: '',
  area: '113',
  experience: '',
  employment: 'full',
  schedule: '',
  salaryFrom: null,
  onlyWithSalary: false,
  excludedKeywords: [],
  excludedEmployers: [],
  maxQueueSize: 30,
  maxPages: 2,
  coverLetterTemplate:
    'Здравствуйте! Меня заинтересовала вакансия «{vacancy}» в {company}. ' +
    'Буду рад обсудить мой релевантный опыт и задачи команды на интервью.',
  autoSend: true,
  resumeTitleContains: '',
  resumeTitles: [],
  delayBetweenSec: 20,
  dailyLimit: 50,
  autoRunDaily: false,
  autoRunHour: 10,
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
    query: String(source.query ?? '').trim().slice(0, 200),
    area: String(source.area ?? DEFAULT_HH_ASSISTANT_CONFIG.area).trim().slice(0, 20),
    experience: String(source.experience ?? '').trim().slice(0, 40),
    employment: String(
      source.employment ?? DEFAULT_HH_ASSISTANT_CONFIG.employment,
    ).trim().slice(0, 40),
    schedule: String(source.schedule ?? '').trim().slice(0, 40),
    salaryFrom:
      Number.isFinite(salary) && salary > 0
        ? boundedInt(salary, 0, 1, 10_000_000)
        : null,
    onlyWithSalary: Boolean(source.onlyWithSalary),
    excludedKeywords: cleanList(source.excludedKeywords),
    excludedEmployers: cleanList(source.excludedEmployers),
    maxQueueSize: boundedInt(source.maxQueueSize, 30, 5, 100),
    maxPages: boundedInt(source.maxPages, 2, 1, 5),
    coverLetterTemplate:
      String(
        source.coverLetterTemplate ?? DEFAULT_HH_ASSISTANT_CONFIG.coverLetterTemplate,
      ).trim().slice(0, 4000) || DEFAULT_HH_ASSISTANT_CONFIG.coverLetterTemplate,
    autoSend: source.autoSend !== undefined ? Boolean(source.autoSend) : true,
    resumeTitleContains: String(source.resumeTitleContains ?? '').trim().slice(0, 200),
    resumeTitles: cleanList(source.resumeTitles),
    delayBetweenSec: boundedInt(source.delayBetweenSec, 20, 5, 120),
    dailyLimit: boundedInt(source.dailyLimit, 50, 1, 200),
    autoRunDaily: Boolean(source.autoRunDaily),
    autoRunHour: boundedInt(source.autoRunHour, 10, 0, 23),
  };
}

export function buildHhSearchUrl(config: HhAssistantConfig, page = 0): string {
  const url = new URL('https://hh.ru/search/vacancy');
  if (config.query) url.searchParams.set('text', config.query);
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
