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
const prepareStyles = fs.readFileSync(
  path.resolve(__dirname, '../styles/prepare.css'),
  'utf8',
);
const vacancySetup = fs.readFileSync(
  path.resolve(__dirname, '../components/prepare/VacancySetup.tsx'),
  'utf8',
);

describe('candidate flow across every primary tab', () => {
  it('gives a new customer one compact resume, HH, live path without a separate onboarding route', () => {
    expect(home).toContain('Добавить резюме');
    expect(home).toContain('Подключить HH');
    expect(home).toContain('Запустить оверлей');
    expect(home).toContain("launchLive(() => navigate('/overlay'))");
    expect(home).not.toContain('Проверить оверлей');
    expect(home).not.toContain("navigate('/onboarding')");
  });

  it('keeps vacancy analysis focused and carries the saved goal into a new review', () => {
    expect(prepare).not.toContain('<CandidateJourneyStrip');
    expect(prepare).toContain("pathname === '/practice/new'");
    expect(vacancySetup).toContain('growthRoleLabel(readGrowthProfile())');
    expect(vacancySetup).toContain('initialDraft.targetRole || goalRoleLabel');
  });

  it('keeps the vacancy analysis action readable in the standard desktop window', () => {
    expect(prepareStyles).toMatch(
      /\.prep-setup-submit\s+\.prep-btn\s*\{[^}]*white-space:\s*nowrap;/s,
    );
  });

  it('opens the requested applications mode and conversation view', () => {
    expect(applications).toContain("searchParams.get('mode') === 'settings'");
    expect(applications).toContain("searchParams.get('view')");
    expect(applications).toContain("setQueueView(requestedView as typeof queueView)");
  });

  it('opens the automatic queue from the home command instead of silently staying on home', () => {
    expect(home).toContain("if (hhCommand.action === 'queue')");
    expect(home).toContain("navigate('/applications?view=active')");
  });

  it('connects calendar events back to applications and preparation context', () => {
    expect(calendar).toContain("navigate('/applications')");
    expect(calendar).toContain('Что ждёт на созвоне');
    expect(calendar).toContain('Требования вакансии не добавлены');
  });

  it('keeps one explicit preparation role in Profile & experience', () => {
    expect(practice).toContain('{scheduledVacancy && <section');
    expect(practice).not.toContain('scheduledVacancy && !inProgress');
    expect(documents).toContain('<GrowthProfileSetup');
    expect(documents).toContain('section=role');
    expect(documents).not.toContain('профессиональную цель');
  });

  it('keeps practice and real interviews as separate destinations', () => {
    expect(practice).toContain('Завершённые тренировки');
    expect(practice).toContain('Новая практика');
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
