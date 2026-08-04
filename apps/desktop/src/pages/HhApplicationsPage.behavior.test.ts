import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pageSource = fs.readFileSync(path.resolve(__dirname, 'HhApplicationsPage.tsx'), 'utf8');
const assistantSource = fs.readFileSync(
  path.resolve(__dirname, '../../electron/hhBrowserAssistant.ts'),
  'utf8',
);
const mainSource = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve(__dirname, '../../electron/preload.ts'), 'utf8');
const electronTypesSource = fs.readFileSync(
  path.resolve(__dirname, '../types/electron.d.ts'),
  'utf8',
);

describe('HH applications redesign', () => {
  it('uses the passwordless email and one-time-code flow end to end', () => {
    expect(pageSource).toContain('assistant.requestLoginCode(email)');
    expect(pageSource).toContain('assistant.confirmLoginCode(code)');
    expect(pageSource).not.toContain('type="password"');
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:request-login-code'");
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:confirm-login-code'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:request-login-code'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:confirm-login-code'");
  });

  it('does not claim that a fresh, unchecked browser session is connected', () => {
    expect(pageSource).toContain(
      'const hhConnected = Boolean(state?.browserOpen && !state.loginRequired)',
    );
    expect(pageSource).toContain("hhConnected ? 'HH подключён' : 'Подключите HH'");
  });

  it('waits for the code entry screen before reporting that the code was sent', () => {
    const requestAt = assistantSource.indexOf('async requestLoginCode');
    const confirmAt = assistantSource.indexOf('async confirmLoginCode');
    const requestSource = assistantSource.slice(requestAt, confirmAt);
    const applicantStepAt = requestSource.indexOf('account-type-card-APPLICANT');
    const emailMethodAt = requestSource.indexOf('credential-type-email');
    const emailInputAt = requestSource.indexOf('applicant-login-input-email');
    const codeInputAt = requestSource.indexOf('const codeInput =');
    const waitAt = requestSource.indexOf("await codeInput.waitFor({ state: 'visible'", codeInputAt);
    const successAt = requestSource.indexOf("message: 'Код отправлен на почту.'");
    expect(applicantStepAt).toBeGreaterThan(-1);
    expect(emailMethodAt).toBeGreaterThan(-1);
    expect(emailInputAt).toBeGreaterThan(-1);
    expect(codeInputAt).toBeGreaterThan(applicantStepAt);
    expect(codeInputAt).toBeGreaterThan(emailMethodAt);
    expect(waitAt).toBeGreaterThan(codeInputAt);
    expect(successAt).toBeGreaterThan(waitAt);
  });

  it('opens the passwordless flow with a post-login resumes destination', () => {
    const requestAt = assistantSource.indexOf('async requestLoginCode');
    const confirmAt = assistantSource.indexOf('async confirmLoginCode', requestAt);
    const requestSource = assistantSource.slice(requestAt, confirmAt);
    expect(requestSource).toContain(
      'https://hh.ru/account/login?backurl=%2Fapplicant%2Fresumes&role=applicant',
    );
  });

  it('confirms login only after the authenticated applicant menu appears', () => {
    const confirmAt = assistantSource.indexOf('async confirmLoginCode');
    const loginRequiredAt = assistantSource.indexOf('private async isLoginRequired', confirmAt);
    const confirmSource = assistantSource.slice(confirmAt, loginRequiredAt);
    const applicantMenuAt = confirmSource.indexOf('const applicantMenu =');
    const waitAt = confirmSource.indexOf(".waitFor({ state: 'visible'", applicantMenuAt);
    const successAt = confirmSource.indexOf("message: 'HH подключён.'");
    expect(applicantMenuAt).toBeGreaterThan(-1);
    expect(waitAt).toBeGreaterThan(applicantMenuAt);
    expect(successAt).toBeGreaterThan(waitAt);
  });

  it('does not submit the one-time code twice and recovers HHs post-login 404', () => {
    const confirmAt = assistantSource.indexOf('async confirmLoginCode');
    const resumesAt = assistantSource.indexOf('async getApplicantResumes', confirmAt);
    const confirmSource = assistantSource.slice(confirmAt, resumesAt);
    expect(confirmSource).toContain("if (page.url().includes('/account/login'))");
    expect(confirmSource).toContain('button[type="submit"]:has-text("Войти")');
    expect(confirmSource).not.toContain(
      'button[data-qa="account-login-submit"], button[type="submit"],',
    );
    expect(confirmSource).toContain("if (page.url().includes('/404'))");
    expect(confirmSource).toContain("page.goto('https://hh.ru/applicant/resumes'");
  });

  it('loads real resumes through the authenticated browser IPC boundary', () => {
    expect(assistantSource).toContain('async getApplicantResumes()');
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:get-resumes'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:get-resumes')");
    expect(electronTypesSource).toContain('getResumes: () => Promise<Array<');
    expect(pageSource).toContain('assistant.getResumes().then(setResumes)');
    expect(pageSource).toContain('resumes.map((resume) => {');
    expect(pageSource).toContain('type="checkbox"');
    expect(pageSource).toContain('draft.resumeTitles.includes(resume.title)');
    expect(pageSource).not.toContain('placeholder="Часть названия резюме"');
  });

  it('keeps search and automation settings hidden until HH is authenticated', () => {
    const gateAt = pageSource.indexOf('{!hhConnected ? (');
    const settingsAt = pageSource.indexOf('Что искать');
    expect(gateAt).toBeGreaterThan(-1);
    expect(settingsAt).toBeGreaterThan(gateAt);
    expect(pageSource).toContain(
      'Сначала подключите HH — после входа появятся ваши резюме и настройки автооткликов.',
    );
  });

  it('runs the queue without a daily cap or an artificial pause between vacancies', () => {
    const runQueueAt = assistantSource.indexOf('private async runQueue');
    const applyAllAt = assistantSource.indexOf('async applyAll', runQueueAt);
    const runQueueSource = assistantSource.slice(runQueueAt, applyAllAt);
    expect(runQueueSource).not.toContain('canSendMore');
    expect(runQueueSource).not.toContain('dailyLimit');
    expect(runQueueSource).not.toContain('delayBetweenSec');
    expect(runQueueSource).not.toContain('setTimeout');
  });

  it('keeps the redesigned compact search, schedule, and recent-applications UI', () => {
    expect(pageSource).toContain('1. Выберите резюме');
    expect(pageSource).toContain('2. Что искать');
    expect(pageSource).toContain('3. Когда запускать каждый день');
    expect(pageSource).toContain('Последние отклики');
  });

  it('enables the daily schedule and immediately scans before applying', () => {
    const actionAt = pageSource.indexOf('const saveAutomation = async () =>');
    const actionEndAt = pageSource.indexOf('const activeQueue', actionAt);
    const actionSource = pageSource.slice(actionAt, actionEndAt);
    const saveAt = actionSource.indexOf('assistant.saveConfig(');
    const scheduleAt = actionSource.indexOf('assistant.setDailySchedule(true)');
    const scanAt = actionSource.indexOf('assistant.scan()');
    const applyAt = actionSource.indexOf('assistant.applyAll()');

    expect(actionAt).toBeGreaterThan(-1);
    expect(actionSource).toContain('autoRunDaily: true');
    expect(saveAt).toBeGreaterThan(-1);
    expect(scheduleAt).toBeGreaterThan(saveAt);
    expect(scanAt).toBeGreaterThan(scheduleAt);
    expect(applyAt).toBeGreaterThan(scanAt);
    expect(pageSource).toContain('Включить автоотклики');
    expect(pageSource).toContain('draft.resumeTitles.length === 0');
    expect(pageSource).not.toContain('Найти сейчас');
    expect(pageSource).not.toContain('Найти и откликнуться');
  });

  it('keeps legacy resume selection while ranking among newly selected resumes', () => {
    expect(electronTypesSource).toContain('resumeTitles: string[]');
    expect(assistantSource).toContain('selectedTitles: string[], vacancyTitle: string');
    expect(assistantSource).toContain('this.state.config.resumeTitles.length > 0');
    expect(assistantSource).toContain('[this.state.config.resumeTitleContains].filter(Boolean)');
    expect(assistantSource).toContain('score > best.score');
  });
});
