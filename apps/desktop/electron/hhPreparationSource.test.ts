import { describe, expect, it } from 'vitest';
import { parseHhResumeText, parseHhVacancyPage } from './hhPreparationSource';

describe('HH preparation sources', () => {
  it('extracts only useful resume cards and removes page state and contacts', () => {
    const html = `
      <main>
        <div data-qa="resume-position-card"><h1>QA Automation Engineer</h1><p>Python · pytest</p></div>
        <div data-qa="resume-contacts-phone">+7 999 000-00-00</div>
        <section data-qa="resume-list-card-experience">
          <h2>Опыт работы</h2><article>SkillCue — автоматизировал API-тесты</article>
          <script>{"hugeApplicationState":"must not enter prompt"}</script>
        </section>
        <div data-qa="skills-card"><span>Python</span><span>Playwright</span></div>
        <footer>Рекомендованные вакансии</footer>
      </main>`;

    const text = parseHhResumeText(html);

    expect(text).toContain('QA Automation Engineer');
    expect(text).toContain('автоматизировал API-тесты');
    expect(text).toContain('Playwright');
    expect(text).not.toContain('+7 999');
    expect(text).not.toContain('hugeApplicationState');
    expect(text).not.toContain('Рекомендованные вакансии');
  });

  it('reads a server-rendered HH vacancy from JSON-LD without opening a page', () => {
    const html = `
      <html><head><script type="application/ld+json">
        {
          "@context":"https://schema.org/",
          "@type":"JobPosting",
          "title":"QA Automation Engineer (Python)",
          "hiringOrganization":{"@type":"Organization","name":"the_covert"},
          "description":"<p>Ищем инженера с Python.</p><ul><li>API-тестирование</li><li>CI/CD</li></ul>"
        }
      </script></head></html>`;

    const vacancy = parseHhVacancyPage(
      'https://hh.ru/vacancy/135995132?from=share_ios',
      html,
    );

    expect(vacancy.id).toBe('135995132');
    expect(vacancy.url).toBe('https://hh.ru/vacancy/135995132');
    expect(vacancy.title).toBe('QA Automation Engineer (Python)');
    expect(vacancy.company).toBe('the_covert');
    expect(vacancy.text).toContain('API-тестирование');
    expect(vacancy.text).toContain('CI/CD');
  });

  it('rejects non-HH and incomplete vacancy pages', () => {
    expect(() => parseHhVacancyPage('https://example.com/vacancy/1', '<html />'))
      .toThrow('Вставьте ссылку');
    expect(() => parseHhVacancyPage('https://hh.ru/vacancy/123', '<html />'))
      .toThrow('полное описание');
  });
});
