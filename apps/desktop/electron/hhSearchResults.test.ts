import { describe, expect, it } from 'vitest';
import { parseHhSearchResults } from './hhSearchResults';

describe('HH search results snapshot parser', () => {
  it('returns cards immediately when salary is absent', () => {
    const cards = parseHhSearchResults(`
      <main>
        <article data-qa="vacancy-serp__vacancy">
          <a data-qa="serp-item__title" href="https://hh.ru/vacancy/101">QA Automation Engineer</a>
          <span data-qa="vacancy-serp__vacancy-employer"></span>
          <span data-qa="vacancy-serp__vacancy-employer-text">Qualitica</span>
        </article>
        <article data-qa="vacancy-serp__vacancy">
          <a data-qa="vacancy-serp__vacancy-title" href="/vacancy/102">Python QA</a>
          <span data-qa="vacancy-serp__vacancy-employer">Example</span>
          <span data-qa="vacancy-serp__vacancy-compensation">от 200 000 ₽</span>
          <span data-qa="vacancy-serp__vacancy_responded">Вы откликнулись</span>
        </article>
      </main>
    `);

    expect(cards).toEqual([
      {
        title: 'QA Automation Engineer',
        rawUrl: 'https://hh.ru/vacancy/101',
        company: 'Qualitica',
        salary: '',
        alreadyApplied: false,
      },
      {
        title: 'Python QA',
        rawUrl: '/vacancy/102',
        company: 'Example',
        salary: 'от 200 000 ₽',
        alreadyApplied: true,
      },
    ]);
  });

  it('recognises the HH responded marker before a vacancy is opened', () => {
    const [card] = parseHhSearchResults(`
      <article data-qa="vacancy-serp__vacancy">
        <a data-qa="serp-item__title" href="/vacancy/136019660">Senior QA Automation Engineer</a>
        <span data-qa="vacancy-serp__vacancy_responded">Вы откликнулись</span>
      </article>
    `);

    expect(card.alreadyApplied).toBe(true);
  });

  it('honours the result limit without reading unrelated page links', () => {
    const html = Array.from({ length: 4 }, (_, index) => `
      <article data-qa="vacancy-serp__vacancy">
        <a data-qa="serp-item__title" href="/vacancy/${index}">Role ${index}</a>
      </article>
    `).join('');

    expect(parseHhSearchResults(html, 2).map((item) => item.title)).toEqual(['Role 0', 'Role 1']);
  });
});
