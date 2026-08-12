import * as cheerio from 'cheerio';

export interface HhSearchResultCard {
  title: string;
  rawUrl: string;
  company: string;
  salary: string;
  alreadyApplied: boolean;
}

const CARD_SELECTOR = '[data-qa="vacancy-serp__vacancy"]';
const TITLE_SELECTOR =
  '[data-qa="serp-item__title"], [data-qa="vacancy-serp__vacancy-title"]';
const COMPANY_SELECTOR =
  '[data-qa="vacancy-serp__vacancy-employer"], [data-qa="vacancy-serp__vacancy-employer-text"]';
const SALARY_SELECTOR =
  '[data-qa="vacancy-serp__vacancy-compensation"], [data-qa="vacancy-serp__vacancy-salary"]';

/**
 * Read every HH search card from one HTML snapshot. Missing optional fields,
 * especially salary, must never trigger a per-card Playwright timeout.
 */
export function parseHhSearchResults(html: string, limit = 100): HhSearchResultCard[] {
  const $ = cheerio.load(html);
  return $(CARD_SELECTOR)
    .slice(0, Math.max(0, limit))
    .toArray()
    .flatMap((element) => {
      const card = $(element);
      const firstText = (selector: string): string => {
        for (const candidate of card.find(selector).toArray()) {
          const value = $(candidate).text().replace(/\s+/g, ' ').trim();
          if (value) return value;
        }
        return '';
      };
      const titleLink = card.find(TITLE_SELECTOR).first();
      const title = titleLink.text().replace(/\s+/g, ' ').trim();
      const rawUrl = String(titleLink.attr('href') ?? '').trim();
      if (!title || !rawUrl) return [];
      return [{
        title,
        rawUrl,
        company: firstText(COMPANY_SELECTOR),
        salary: firstText(SALARY_SELECTOR),
        alreadyApplied:
          card.find('[data-qa="vacancy-serp__vacancy_responded"]').length > 0
          || /вы\s+откликнулись/i.test(card.text()),
      }];
    });
}
