import * as cheerio from 'cheerio';
import { normalizeHhVacancyUrl } from './hhAssistantPolicy';

export interface HhPreparationResume {
  id: string;
  title: string;
  url: string;
  text: string;
}

export interface HhPreparationVacancy {
  id: string;
  title: string;
  company: string;
  salary: string;
  url: string;
  description: string;
  text: string;
}

type JsonRecord = Record<string, unknown>;

const textValue = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/** Converts the useful content of a server-rendered HH block to readable text. */
export function hhHtmlToText(fragment: string): string {
  const $ = cheerio.load(`<main>${fragment}</main>`);
  $('script, style, template, noscript, svg, button, form').remove();
  $('br').replaceWith('\n');
  $('li').each((_index, element) => {
    $(element).prepend('• ').append('\n');
  });
  $('p, h1, h2, h3, h4, section, article').each((_index, element) => {
    $(element).append('\n');
  });
  return $('main')
    .text()
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * HH resume pages contain a lot of application state alongside the visible
 * resume. Read only the semantic cards so prompts never receive navigation,
 * contacts, tracking configuration, or unrelated recommendations.
 */
export function parseHhResumeText(html: string): string {
  const $ = cheerio.load(html);
  const selectors = [
    '[data-qa="resume-position-card"]',
    '[data-qa="resume-list-card-experience"]',
    '[data-qa="skills-card"]',
    '[data-qa="resume-list-card-education"]',
    '[data-qa="resume-about-card"]',
  ];
  const parts = selectors.flatMap((selector) =>
    $(selector)
      .toArray()
      .map((element) => hhHtmlToText($.html(element)))
      .filter((part) => part.length >= 2),
  );
  return [...new Set(parts)].join('\n\n').slice(0, 16_000).trim();
}

function jobPostingFromJsonLd(value: unknown): JsonRecord | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = jobPostingFromJsonLd(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as JsonRecord;
  const type = record['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return record;
  return jobPostingFromJsonLd(record['@graph']);
}

function formatSalary(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const salary = value as JsonRecord;
  const currency = textValue(salary.currency);
  const rawValue = salary.value;
  if (typeof rawValue === 'number' || typeof rawValue === 'string') {
    return `${rawValue}${currency ? ` ${currency}` : ''}`.trim();
  }
  if (!rawValue || typeof rawValue !== 'object') return '';
  const range = rawValue as JsonRecord;
  const exact = range.value;
  const min = range.minValue;
  const max = range.maxValue;
  const amount = exact != null
    ? String(exact)
    : min != null && max != null
      ? `${min}–${max}`
      : min != null
        ? `от ${min}`
        : max != null
          ? `до ${max}`
          : '';
  return `${amount}${currency ? ` ${currency}` : ''}`.trim();
}

export function parseHhVacancyPage(rawUrl: string, html: string): HhPreparationVacancy {
  const url = normalizeHhVacancyUrl(rawUrl);
  const id = url.match(/\/vacancy\/(\d+)$/)?.[1] ?? '';
  if (!url || !id) throw new Error('Вставьте ссылку вида https://hh.ru/vacancy/123456.');

  const $ = cheerio.load(html);
  let posting: JsonRecord | null = null;
  const jsonLdBlocks = $('script[type="application/ld+json"]').toArray();
  for (const element of jsonLdBlocks) {
    try {
      posting = jobPostingFromJsonLd(JSON.parse($(element).text()));
    } catch {
      // A malformed auxiliary JSON-LD block must not hide the main vacancy.
    }
    if (posting) break;
  }

  const fallbackText = (selector: string) => hhHtmlToText($(selector).first().html() ?? '');
  const title = textValue(posting?.title) || fallbackText('[data-qa="vacancy-title"]');
  const organization = posting?.hiringOrganization;
  const company = organization && typeof organization === 'object'
    ? textValue((organization as JsonRecord).name)
    : fallbackText('[data-qa="vacancy-company-name"]');
  const descriptionHtml = textValue(posting?.description)
    ? String(posting?.description)
    : ($('[data-qa="vacancy-description"]').first().html() ?? '');
  const description = hhHtmlToText(descriptionHtml).slice(0, 20_000);
  const salary = formatSalary(posting?.baseSalary)
    || fallbackText('[data-qa="vacancy-salary"]');

  if (!title || description.length < 40) {
    throw new Error('HH не отдал полное описание вакансии. Проверьте ссылку или повторите позже.');
  }
  const header = [title, company && `Компания: ${company}`, salary && `Зарплата: ${salary}`]
    .filter(Boolean)
    .join('\n');
  return {
    id,
    title: title.slice(0, 300),
    company: company.slice(0, 300),
    salary: salary.slice(0, 120),
    url,
    description,
    text: `${header}\n\n${description}`.slice(0, 22_000),
  };
}
