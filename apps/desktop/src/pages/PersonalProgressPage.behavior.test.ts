import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const page = fs.readFileSync(path.resolve(__dirname, 'PersonalProgressPage.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(__dirname, '../components/Sidebar.tsx'), 'utf8');
const api = fs.readFileSync(path.resolve(__dirname, '../lib/api.ts'), 'utf8');

describe('personal progress page', () => {
  it('is a separate destination from vacancy readiness', () => {
    expect(app).toContain('path="/progress"');
    expect(sidebar).toContain("to: '/progress'");
    expect(sidebar).toContain("label: 'nav.progress'");
  });

  it('shows separate technical and HR evidence without treating missing topics as gaps', () => {
    expect(page).toContain('profile.technical');
    expect(page).toContain('profile.hr');
    expect(page).toContain('ТЕХНИЧЕСКАЯ КАРТИНА');
    expect(page).toContain('HR И САМОПРЕЗЕНТАЦИЯ');
    expect(page).toContain('Пока не проверялось');
  });

  it('asks for consent and scopes assessment to the selected specialization', () => {
    expect(page).toContain('ДОБРОВОЛЬНАЯ НАСТРОЙКА');
    expect(page).toContain('Смежные направления');
    expect(page).toContain('учитываем только выбранные вами');
    expect(page).toContain('skillcue.growth-profile.v1');
    expect(page).toContain("'qa-python'");
  });

  it('loads the aggregate built from persisted per-session AI analyses', () => {
    expect(api).toContain('getDevelopmentProfile:');
    expect(page).toContain('api.getDevelopmentProfile()');
    expect(page).toContain('recentSessions');
  });
});
