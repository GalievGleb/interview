import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  extractHhResumesFromHtml,
  extractHhResumeTitleFromHtml,
  findExplicitlySelectedHhResume,
  HhBrowserAssistant,
  type HhApplicantResume,
  resumeTitleMatches,
} from './hhBrowserAssistant';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

  it('selects the exact 220k resume instead of a fuzzy 240k match', () => {
    const resumes = [
      {
        id: '240',
        title: 'Постоянная работа, подработка QA Automation Engineer Python 240 000 ₽ · Удалённо',
        url: 'https://hh.ru/resume/24000000',
      },
      {
        id: '220',
        title: 'Постоянная работа, подработка QA Automation Engineer Python 220 000 ₽ · Удалённо',
        url: 'https://hh.ru/resume/22000000',
      },
    ];

    expect(findExplicitlySelectedHhResume(
      resumes,
      'Постоянная работа, подработка QA Automation Engineer Python 220 000 ₽ · Удалённо',
    )?.id).toBe('220');
    expect(findExplicitlySelectedHhResume(resumes, 'QA Automation Engineer Python')).toBeUndefined();
    expect(findExplicitlySelectedHhResume(
      [{ id: 'expanded', title: 'QA Engineer Manual + Automation', url: 'https://hh.ru/resume/expanded000' }],
      'QA Engineer',
    )).toBeUndefined();
    expect(findExplicitlySelectedHhResume(
      [resumes[0]],
      'Постоянная работа, подработка QA Automation Engineer Python 220 000 ₽ · Удалённо',
    )).toBeUndefined();
    expect(findExplicitlySelectedHhResume(
      [resumes[1], { ...resumes[1], id: '220-duplicate' }],
      resumes[1].title,
    )).toBeUndefined();
  });

  it('never lets resume synchronization replace a configured 220k title with a fuzzy 240k card', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-resume-sync-exact-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const selectedTitle = 'QA Automation Engineer Python 220 000 ₽ · Удалённо';
    const fuzzyOtherTitle = 'QA Automation Engineer Python 240 000 ₽ · Удалённо';
    assistant.saveConfig({
      resumeTitles: [selectedTitle],
      resumeSelectionExplicitlyConfirmed: true,
    });
    const mutable = assistant as unknown as {
      syncCurrentApplicantResume: (resumes: HhApplicantResume[]) => void;
      resumeSelectionConfirmed: boolean;
    };

    mutable.syncCurrentApplicantResume([
      { id: '240', title: fuzzyOtherTitle, url: 'https://hh.ru/resume/24000000' },
      { id: '220', title: selectedTitle, url: 'https://hh.ru/resume/22000000' },
    ]);
    expect(assistant.getState().config.resumeTitles).toEqual([selectedTitle]);

    mutable.syncCurrentApplicantResume([
      { id: '240', title: fuzzyOtherTitle, url: 'https://hh.ru/resume/24000000' },
    ]);
    expect(assistant.getState().config.resumeTitles).toEqual([]);
    expect(mutable.resumeSelectionConfirmed).toBe(false);
  });

  it('does not treat an auto-populated resume title as explicit confirmation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-resume-confirmation-'));
    directories.push(directory);
    const selectedTitle = 'QA Automation Engineer Python 220 000 ₽ · Удалённо';
    const assistant = new HhBrowserAssistant(directory, () => undefined);

    assistant.saveConfig({ resumeTitles: [selectedTitle], autoSend: false });
    let persisted = JSON.parse(fs.readFileSync(
      path.join(directory, 'hh-browser-assistant.json'),
      'utf8',
    )) as { resumeSelectionConfirmed?: boolean };
    expect(persisted.resumeSelectionConfirmed).toBe(false);

    assistant.saveConfig({
      resumeTitles: [selectedTitle],
      resumeSelectionExplicitlyConfirmed: true,
      autoSend: false,
    });
    persisted = JSON.parse(fs.readFileSync(
      path.join(directory, 'hh-browser-assistant.json'),
      'utf8',
    )) as { resumeSelectionConfirmed?: boolean };
    expect(persisted.resumeSelectionConfirmed).toBe(true);
  });

  it('invalidates a deleted confirmed resume during a background resume lookup', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-resume-background-invalidate-'));
    directories.push(directory);
    const removedTitle = 'QA Automation Engineer Python 220 000 ₽ · Удалённо';
    const raw = new HhBrowserAssistant(directory, () => undefined);
    raw.saveConfig({
      resumeTitles: [removedTitle],
      resumeSelectionExplicitlyConfirmed: true,
      autoSend: false,
    });
    const remaining: HhApplicantResume[] = [
      { id: 'manual', title: 'QA Manual Engineer', url: 'https://hh.ru/resume/manual000' },
      { id: 'fullstack', title: 'QA Fullstack Engineer 240 000 ₽', url: 'https://hh.ru/resume/fullstack000' },
    ];
    const assistant = raw as unknown as {
      context: object;
      applicantResumes: HhApplicantResume[];
      resumeSelectionConfirmed: boolean;
      readApplicantResumesFromSession: () => Promise<{
        resumes: HhApplicantResume[];
        loginRequired: boolean;
      }>;
      getConfiguredSearchResumeContext: () => Promise<string>;
    };
    assistant.context = {};
    assistant.applicantResumes = [];
    assistant.readApplicantResumesFromSession = vi.fn(async () => ({
      resumes: remaining,
      loginRequired: false,
    }));

    const context = await assistant.getConfiguredSearchResumeContext();

    expect(context).toBe('');
    expect(raw.getState().config.resumeTitles).toEqual([]);
    expect(assistant.resumeSelectionConfirmed).toBe(false);
  });

  it('loads content from the exact persisted resume title', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-selected-resume-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined);
    const resumes: HhApplicantResume[] = [
      { id: '240', title: 'QA Automation Engineer Python 240 000 ₽', url: 'https://hh.ru/resume/24000000' },
      { id: '220', title: 'QA Automation Engineer Python 220 000 ₽', url: 'https://hh.ru/resume/22000000' },
    ];
    const getContent = vi.fn(async (id: string) => ({
      ...resumes.find((resume) => resume.id === id)!,
      text: `Город проживания: Казань\nresume ${id}`,
    }));
    const mutable = assistant as unknown as {
      context: object;
      applicantResumes: HhApplicantResume[];
      getApplicantResumeContent: typeof getContent;
    };
    mutable.context = {};
    mutable.applicantResumes = resumes;
    mutable.getApplicantResumeContent = getContent;

    const result = await assistant.getSelectedResumeText('QA Automation Engineer', {
      throwOnFailure: true,
      selectedResumeTitle: resumes[1].title,
    });

    expect(getContent).toHaveBeenCalledWith('220');
    expect(result).toContain('220 000 ₽');
    expect(result).toContain('Город проживания: Казань');

  });

  it('refreshes an expired resume body before using salary or city facts', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-resume-cache-freshness-'));
    directories.push(directory);
    const resume: HhApplicantResume = {
      id: 'selected',
      title: 'QA Automation Engineer Python 220 000 ₽',
      url: 'https://hh.ru/resume/selected000',
    };
    const requestGet = vi.fn(async () => ({
      ok: () => true,
      text: async () => `
        <div data-qa="resume-personal-address">Казань</div>
        <section data-qa="resume-position-card">
          QA Automation Engineer Python. Опыт автоматизации API и UI тестирования,
          разработка автотестов, CI/CD, SQL, Docker и командная работа.
        </section>
      `,
    }));
    const raw = new HhBrowserAssistant(directory, () => undefined);
    const assistant = raw as unknown as {
      context: { request: { get: typeof requestGet } };
      applicantResumes: HhApplicantResume[];
      resumeTextCache: Map<string, { text: string; cachedAt: number }>;
      ensureBrowser: () => Promise<object>;
    };
    assistant.context = { request: { get: requestGet } };
    assistant.applicantResumes = [resume];
    assistant.resumeTextCache.set(resume.id, {
      text: 'Город проживания: Москва\nСтарое содержимое резюме.',
      cachedAt: 0,
    });
    assistant.ensureBrowser = vi.fn(async () => ({}));

    const result = await raw.getApplicantResumeContent(resume.id);

    expect(requestGet).toHaveBeenCalledOnce();
    expect(result.text).toContain('Город проживания: Казань');
    expect(result.text).not.toContain('Москва');
  });

  it('selects the exact salary resume in the legacy response form and rejects a missing one', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-select-resume-form-'));
    directories.push(directory);
    const assistant = new HhBrowserAssistant(directory, () => undefined) as unknown as {
      selectPreferredResume: (page: Page, titles: string[], vacancyTitle: string) => Promise<void>;
    };
    const itemTitles = [
      'QA Automation Engineer Python 240 000 ₽',
      'QA Automation Engineer Python 220 000 ₽',
    ];
    const clicks = itemTitles.map(() => vi.fn(async () => undefined));
    const emptyModern = {
      count: vi.fn(async () => 0),
      nth: vi.fn(),
    };
    const legacy = {
      count: vi.fn(async () => itemTitles.length),
      nth: (index: number) => ({
        innerText: vi.fn(async () => itemTitles[index]),
        click: clicks[index],
        locator: vi.fn(() => ({ count: vi.fn(async () => 0), first: vi.fn() })),
        getAttribute: vi.fn(async (name: string) => (
          index === 1 && name === 'aria-selected' ? 'true' : null
        )),
      }),
    };
    const page = {
      locator: vi.fn((selector: string) => (
        selector === '[data-qa="resume-title"]' ? emptyModern : legacy
      )),
      waitForTimeout: vi.fn(async () => undefined),
    } as unknown as Page;

    await assistant.selectPreferredResume(
      page,
      ['QA Automation Engineer Python 220 000 ₽'],
      'QA Automation Engineer',
    );
    expect(clicks[0]).not.toHaveBeenCalled();
    expect(clicks[1]).toHaveBeenCalledOnce();

    const unconfirmedLegacy = {
      count: vi.fn(async () => itemTitles.length),
      nth: (index: number) => ({
        innerText: vi.fn(async () => itemTitles[index]),
        click: vi.fn(async () => undefined),
        locator: vi.fn(() => ({ count: vi.fn(async () => 0), first: vi.fn() })),
        getAttribute: vi.fn(async () => null),
      }),
    };
    const unconfirmedPage = {
      locator: vi.fn((selector: string) => (
        selector === '[data-qa="resume-title"]' ? emptyModern : unconfirmedLegacy
      )),
      waitForTimeout: vi.fn(async () => undefined),
    } as unknown as Page;
    await expect(assistant.selectPreferredResume(
      unconfirmedPage,
      ['QA Automation Engineer Python 220 000 ₽'],
      'QA Automation Engineer',
    )).rejects.toThrow('HH не подтвердил выбор резюме');

    await expect(assistant.selectPreferredResume(
      page,
      ['QA Automation Engineer Python 230 000 ₽'],
      'QA Automation Engineer',
    )).rejects.toThrow('не найдено в форме отклика HH');

    clicks[1].mockRejectedValueOnce(new Error('detached'));
    await expect(assistant.selectPreferredResume(
      page,
      ['QA Automation Engineer Python 220 000 ₽'],
      'QA Automation Engineer',
    )).rejects.toThrow('Не удалось выбрать резюме');

    legacy.count.mockResolvedValueOnce(0);
    await expect(assistant.selectPreferredResume(
      page,
      ['QA Automation Engineer Python 220 000 ₽'],
      'QA Automation Engineer',
    )).rejects.toThrow('не найдено в форме отклика HH');
  });

  it('schedules an automatic retry when the current HH resume list cannot be loaded', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-missing-selected-resume-'));
    directories.push(directory);
    const raw = new HhBrowserAssistant(directory, () => undefined);
    const page = {
      url: vi.fn(() => 'https://hh.ru/'),
      goto: vi.fn(),
    } as unknown as Page;
    const assistant = raw as unknown as {
      ensureBrowser: () => Promise<Page>;
      preferredApplicantResume: () => Promise<undefined>;
      applyToVacancy: (vacancy: {
        key: string; platform: 'hh'; id: string; title: string; company: string;
        salary: string; url: string; status: 'new'; addedAt: string; selectedResumeTitle: string;
      }) => Promise<{ blocked: boolean; reason: string; autoRetryBlockedUntil?: string }>;
    };
    assistant.ensureBrowser = vi.fn(async () => page);
    assistant.preferredApplicantResume = vi.fn(async () => undefined);

    const result = await assistant.applyToVacancy({
      key: 'hh:135603644',
      platform: 'hh',
      id: '135603644',
      title: 'QA Engineer (Manual + Automation)',
      company: 'ГКУ Инфогород',
      salary: '',
      url: 'https://hh.ru/vacancy/135603644',
      status: 'new',
      addedAt: new Date().toISOString(),
      selectedResumeTitle: 'QA Automation Engineer Python 220 000 ₽',
    });

    expect(result).toMatchObject({ blocked: false, autoRetryBlockedUntil: 'daily' });
    expect(result.reason).toContain('Автоматически повторю позже');
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('automatically skips one ambiguous vacancy without stopping the queue', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-ambiguous-legacy-resume-'));
    directories.push(directory);
    const raw = new HhBrowserAssistant(directory, () => undefined);
    const page = {
      url: vi.fn(() => 'https://hh.ru/'),
      goto: vi.fn(),
    } as unknown as Page;
    const assistant = raw as unknown as {
      applicantResumes: HhApplicantResume[];
      ensureBrowser: () => Promise<Page>;
      preferredApplicantResume: () => Promise<undefined>;
      applyToVacancy: (vacancy: {
        key: string; platform: 'hh'; id: string; title: string; company: string;
        salary: string; url: string; status: 'new'; addedAt: string;
      }) => Promise<{ blocked: boolean; reason: string; autoRetryBlockedUntil?: string }>;
    };
    assistant.applicantResumes = [
      { id: 'one', title: 'QA Automation Engineer', url: 'https://hh.ru/resume/duplicate-one' },
      { id: 'two', title: 'QA Automation Engineer', url: 'https://hh.ru/resume/duplicate-two' },
    ];
    assistant.ensureBrowser = vi.fn(async () => page);
    assistant.preferredApplicantResume = vi.fn(async () => undefined);

    const result = await assistant.applyToVacancy({
      key: 'hh:135603645',
      platform: 'hh',
      id: '135603645',
      title: 'QA Engineer',
      company: 'Example',
      salary: '',
      url: 'https://hh.ru/vacancy/135603645',
      status: 'new',
      addedAt: new Date().toISOString(),
    });

    expect(result).toMatchObject({ blocked: false, autoRetryBlockedUntil: undefined });
    expect(result.reason).toContain('Пропущено автоматически');
    expect(raw.getState().queue.find((item) => item.id === '135603645')?.status).toBeUndefined();
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('automatically reranks current HH resumes when a persisted title is stale', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-stale-resume-rerank-'));
    directories.push(directory);
    const resumes: HhApplicantResume[] = [
      { id: 'fullstack', title: 'QA Fullstack Engineer Python 240 000 ₽', url: 'https://hh.ru/resume/fullstack000' },
      { id: 'automation', title: 'QA Automation Engineer Python 220 000 ₽', url: 'https://hh.ru/resume/automation000' },
    ];
    const raw = new HhBrowserAssistant(directory, () => undefined);
    const assistant = raw as unknown as {
      context: object;
      applicantResumes: HhApplicantResume[];
      getApplicantResumeContent: (id: string) => Promise<HhApplicantResume & { text: string }>;
    };
    assistant.context = {};
    assistant.applicantResumes = resumes;
    assistant.getApplicantResumeContent = vi.fn(async (id: string) => ({
      ...resumes.find((resume) => resume.id === id)!,
      text: `resume ${id}`,
    }));

    const text = await raw.getSelectedResumeText('QA Automation Engineer', {
      throwOnFailure: true,
      selectedResumeTitle: 'Старое название резюме, которого больше нет',
    });

    expect(text).toContain('QA Automation Engineer Python 220 000 ₽');
    expect(text).toContain('resume automation');
  });
});
