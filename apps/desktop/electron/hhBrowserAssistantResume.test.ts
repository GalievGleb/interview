import { describe, expect, it } from 'vitest';
import {
  extractHhResumesFromHtml,
  extractHhResumeTitleFromHtml,
  resumeTitleMatches,
} from './hhBrowserAssistant';

describe('HH applicant resume discovery', () => {
  it('deduplicates resume actions and keeps the actual title', () => {
    const id = '0123456789abcdef0123456789abcdef01234567';
    const resumes = extractHhResumesFromHtml(`
      <article data-qa="resume-card">
        <a href="/resume/${id}?hhtmFrom=resume_list">QA Automation Engineer</a>
        <a href="https://hh.ru/resume/${id}/edit">Редактировать</a>
      </article>
    `);

    expect(resumes).toEqual([{
      id,
      title: 'QA Automation Engineer',
      url: `https://hh.ru/resume/${id}`,
    }]);
  });

  it('discovers an escaped resume URL embedded in server data', () => {
    const id = 'abcdef0123456789abcdef0123456789abcdef01';
    const resumes = extractHhResumesFromHtml(
      `{"alternate_url":"https:\\/\\/hh.ru\\/resume\\/${id}?from=applicant_resumes"}`,
    );

    expect(resumes).toEqual([{ id, title: '', url: `https://hh.ru/resume/${id}` }]);
  });

  it('extracts the position from a resume detail page', () => {
    expect(extractHhResumeTitleFromHtml(`
      <html><head><title>Fallback — hh.ru</title></head><body>
        <h1 data-qa="resume-block-title-position">Senior QA / AQA</h1>
      </body></html>
    `)).toBe('Senior QA / AQA');
  });

  it('ignores links outside HH and non-resume routes', () => {
    expect(extractHhResumesFromHtml(`
      <a href="https://example.com/resume/0123456789abcdef">External</a>
      <a href="https://hh.ru/applicant/resumes">My resumes</a>
    `)).toEqual([]);
  });

  it('matches a clean popup title to a verbose resume-card title', () => {
    expect(
      resumeTitleMatches(
        'QA Automation Engineer Python',
        'Постоянная работа, подработка QA Automation Engineer Python 220 000 ₽ · Удалённо',
      ),
    ).toBe(true);
    expect(resumeTitleMatches('Qa fullstack senior', 'QA Automation Engineer Python')).toBe(false);
  });
});
