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
    expect(pageSource).toContain('Что искать');
    expect(pageSource).toContain('Запускать каждый день');
    expect(pageSource).toContain('Последние отклики');
  });
});
