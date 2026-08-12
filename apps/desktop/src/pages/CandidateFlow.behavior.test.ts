import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => fs.readFileSync(path.resolve(__dirname, name), 'utf8');
const home = read('HomePage.tsx');
const prepare = read('PreparePage.tsx');
const applications = read('HhApplicationsPage.tsx');
const calendar = read('InterviewCalendarPage.tsx');
const documents = read('DocumentsPage.tsx');
const history = read('HistoryPage.tsx');
const settings = read('SettingsPage.tsx');
const vacancySetup = fs.readFileSync(
  path.resolve(__dirname, '../components/prepare/VacancySetup.tsx'),
  'utf8',
);

describe('candidate flow across every primary tab', () => {
  it('shows the complete vacancy path on Home without a detached progress step', () => {
    expect(home).toContain('<li>Отклик</li><li>Ответ HR</li>');
    expect(home).toContain('<li>Цель и стартовая точка</li><li>Практика и интервью</li>');
    expect(home).not.toContain('<li>Прогресс</li>');
  });

  it('ends preparation with an employer response and carries the saved goal into a new review', () => {
    expect(prepare).toContain("step('response', 'Ответ HR', 'После отклика')");
    expect(prepare).not.toContain("step('progress'");
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

  it('keeps the goal in Profile & experience and counts real interview evidence', () => {
    expect(documents).toContain('<GrowthProfileSetup');
    expect(documents).toContain('api.getDevelopmentProfile()');
    expect(documents).toContain('hasRealInterviewEvidence');
  });

  it('keeps practice and real interviews distinct in History', () => {
    expect(history).toContain('buildCareerProgress(mockSessions, developmentProfile)');
    expect(history).toContain('ЛИЧНЫЙ ПРОГРЕСС');
    expect(history).toContain('разобрано отдельно от тренировок');
  });

  it('keeps Settings deep links and visible section state in sync', () => {
    expect(settings).toContain('aria-pressed={tab === s.id}');
    expect(settings).toContain("next.set('tab', s.id)");
    expect(settings).toContain('setParams(next, { replace: true })');
  });
});
