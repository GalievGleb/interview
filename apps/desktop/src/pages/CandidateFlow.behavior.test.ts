import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.resolve(__dirname, name), 'utf8');
const home = read('HomePage.tsx');
const prepare = read('PreparePage.tsx');
const applications = read('HhApplicationsPage.tsx');
const calendar = read('InterviewCalendarPage.tsx');
const documents = read('DocumentsPage.tsx');
const practice = read('PracticePage.tsx');
const history = read('HistoryPage.tsx');
const settings = read('SettingsPage.tsx');
const vacancySetup = fs.readFileSync(
  path.resolve(__dirname, '../components/prepare/VacancySetup.tsx'),
  'utf8',
);

describe('candidate flow across every primary tab', () => {
  it('lets a new user start with a vacancy, resume, or practice', () => {
    expect(home).toContain('Добавить вакансию');
    expect(home).toContain('Добавить резюме');
    expect(home).toContain('Начать практику');
    expect(home).toContain("chooseCandidatePath('profile', '/practice')");
  });

  it('keeps vacancy analysis focused and carries the saved goal into a new review', () => {
    expect(prepare).not.toContain('<CandidateJourneyStrip');
    expect(prepare).toContain("pathname === '/practice/new'");
    expect(vacancySetup).toContain('growthRoleLabel(readGrowthProfile())');
    expect(vacancySetup).toContain('initialDraft.targetRole || goalRoleLabel');
  });

  it('opens the requested applications mode and conversation view', () => {
    expect(applications).toContain("searchParams.get('mode') === 'settings'");
    expect(applications).toContain("searchParams.get('view')");
    expect(applications).toContain("setQueueView(requestedView as typeof queueView)");
  });

  it('connects calendar events back to applications and preparation context', () => {
    expect(calendar).toContain("navigate('/applications')");
    expect(calendar).toContain('Что ждёт на созвоне');
    expect(calendar).toContain('Требования вакансии не добавлены');
  });

  it('keeps the professional goal in Profile & experience', () => {
    expect(practice).toContain('{scheduledVacancy && <section');
    expect(practice).not.toContain('scheduledVacancy && !inProgress');
    expect(documents).toContain('<GrowthProfileSetup');
    expect(documents).toContain('section=goal');
  });

  it('keeps practice and real interviews as separate destinations', () => {
    expect(practice).toContain('Последние попытки');
    expect(practice).toContain('По вакансии');
    expect(history).toContain('Реальные разговоры');
    expect(history).not.toContain('listMockSessions');
  });

  it('keeps Settings deep links and visible section state in sync', () => {
    expect(settings).toContain('aria-pressed={tab === s.id}');
    expect(settings).toContain("next.set('tab', s.id)");
    expect(settings).toContain('setParams(next, { replace: true })');
  });
});
