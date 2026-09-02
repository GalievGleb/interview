import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/Sidebar.tsx'), 'utf8');
const layout = fs.readFileSync(path.resolve(__dirname, '../components/Layout.tsx'), 'utf8');
const documents = fs.readFileSync(path.resolve(__dirname, 'DocumentsPage.tsx'), 'utf8');
const growthSetup = fs.readFileSync(path.resolve(__dirname, '../components/candidate/GrowthProfileSetup.tsx'), 'utf8');
const history = fs.readFileSync(path.resolve(__dirname, 'HistoryPage.tsx'), 'utf8');
const practice = fs.readFileSync(path.resolve(__dirname, 'PracticePage.tsx'), 'utf8');

describe('personal progress migration', () => {
  it('removes personal progress as a separate navigation destination', () => {
    expect(sidebar).not.toContain("to: '/progress'");
    expect(layout).not.toContain("'/progress': 'nav.progress'");
    expect(app).not.toContain("import('./pages/PersonalProgressPage')");
    expect(app).toContain('function LegacyProgressRedirect()');
    expect(app).toContain('to="/practice"');
  });

  it('keeps only the role actually used to generate practice in profile and experience', () => {
    expect(documents).toContain('<GrowthProfileSetup');
    expect(documents).toContain("section=role");
    expect(growthSetup).toContain('РОЛЬ ДЛЯ ПОДГОТОВКИ');
    expect(growthSetup).toContain('Другая специализация');
    expect(growthSetup).not.toContain('Добавить стартовую самооценку');
    expect(growthSetup).not.toContain('growth-baseline-disclosure');
  });

  it('keeps role-based setup and saved attempts inside the Practice navigation context', () => {
    expect(app).toContain('path="/practice/new"');
    expect(app).toContain('path="/practice/session"');
    expect(practice).toContain("'/practice/new'");
    expect(practice).toContain('`/practice/session?session=');
  });

  it('keeps role selection accessible and save discoverable', () => {
    expect(growthSetup).toContain('aria-expanded={expanded}');
    expect(growthSetup).toContain('aria-invalid=');
    expect(growthSetup).not.toMatch(/Сохранить роль[^]*disabled=/);
  });

  it('moves progress into practice results and leaves History for real interviews', () => {
    expect(practice).toContain('listSessions()');
    expect(practice).toContain('Завершённые тренировки');
    expect(history).toContain('Реальные разговоры');
    expect(history).not.toContain('buildCareerProgress');
  });

  it('does not render a meaningless score placeholder for unfinished practice', () => {
    expect(practice).not.toContain("score == null ? '—'");
    expect(practice).toContain('{score != null &&');
  });
});
