import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const setupSource = fs.readFileSync(path.resolve(__dirname, 'VacancySetup.tsx'), 'utf8');
const assistantSource = fs.readFileSync(
  path.resolve(__dirname, '../../../electron/hhBrowserAssistant.ts'),
  'utf8',
);
const mainSource = fs.readFileSync(path.resolve(__dirname, '../../../electron/main.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve(__dirname, '../../../electron/preload.ts'), 'utf8');

describe('vacancy preparation from HH', () => {
  it('offers HH resumes alongside local and manual sources', () => {
    expect(setupSource).toContain('Резюме из HH.ru');
    expect(setupSource).toContain('Загруженные в SkillCue');
    expect(setupSource).toContain('Вставить резюме вручную');
    expect(setupSource).toContain('pickPreferredResumeSource');
    expect(setupSource).toContain('assistant.getResumeContent(source.slice(3))');
    expect(setupSource).toContain('RESUME_SOURCE_STORAGE_KEY');
  });

  it('recognizes a standalone HH vacancy link and keeps additional HR context', () => {
    expect(setupSource).toContain('hhVacancyUrlFromInput');
    expect(setupSource).toContain('hhVacancyUrlFromStandaloneInput');
    expect(setupSource).toContain('mergeVacancyWithAdditionalContext');
    expect(setupSource).not.toContain('onPaste={(event)');
    expect(setupSource).toContain('assistant.inspectVacancyUrl(detectedVacancyUrl)');
    expect(setupSource).toContain('vacancyText: resolvedVacancyText');
    expect(setupSource).toContain('resumeText: resumeReady ? resumeText.trim() : undefined');
    expect(setupSource).toContain('Загрузить с HH и разобрать');
  });

  it('exposes read-only HH preparation calls across IPC', () => {
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:get-resume-content'");
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:inspect-vacancy-url'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:get-resume-content'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:inspect-vacancy-url'");
  });

  it('loads vacancy preparation data without navigating or applying', () => {
    const inspectAt = assistantSource.indexOf('async inspectVacancyUrl');
    const nextMethodAt = assistantSource.indexOf('private async isLoginRequired', inspectAt);
    const inspectSource = assistantSource.slice(inspectAt, nextMethodAt);
    expect(inspectAt).toBeGreaterThan(-1);
    expect(inspectSource).toContain('this.context.request.get(url');
    expect(inspectSource).not.toContain('page.goto');
    expect(inspectSource).not.toContain('applyOne');
  });
});
