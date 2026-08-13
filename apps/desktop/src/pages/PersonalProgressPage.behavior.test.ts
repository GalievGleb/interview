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

  it('moves the professional goal and baseline into profile and experience', () => {
    expect(documents).toContain('<GrowthProfileSetup');
    expect(documents).toContain("section=goal");
    expect(growthSetup).toContain('ПРОФЕССИОНАЛЬНАЯ ЦЕЛЬ');
    expect(growthSetup).toContain('Другая специализация');
    expect(growthSetup).toContain('Добавить стартовую самооценку');
    expect(growthSetup).toContain('<details className="growth-baseline-disclosure">');
  });

  it('keeps role-based setup and saved attempts inside the Practice navigation context', () => {
    expect(app).toContain('path="/practice/new"');
    expect(app).toContain('path="/practice/session"');
    expect(practice).toContain("'/practice/new'");
    expect(practice).toContain('`/practice/session?session=');
  });

  it('uses native form semantics and keeps save discoverable', () => {
    expect(growthSetup).toContain('<fieldset className="growth-baseline-row"');
    expect(growthSetup).toContain('<legend className="sr-only">{topic}</legend>');
    expect(growthSetup).toContain('type="radio"');
    expect(growthSetup).toContain('aria-expanded={expanded}');
    expect(growthSetup).toContain('aria-invalid=');
    expect(growthSetup).not.toMatch(/Сохранить цель[^]*disabled=/);
  });

  it('moves progress into practice results and leaves History for real interviews', () => {
    expect(practice).toContain('listSessions()');
    expect(practice).toContain('Последние попытки');
    expect(history).toContain('Реальные разговоры');
    expect(history).not.toContain('buildCareerProgress');
  });
});
