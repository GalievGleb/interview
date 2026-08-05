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
    expect(pageSource).toContain('const connected = Boolean(state?.browserOpen && platformMatches && !state.loginRequired)');
    expect(pageSource).toContain("const hhConnected = draft.platform === 'hh' && connected");
    expect(pageSource).toContain("hhConnected ? 'HH подключён' : 'Подключите аккаунт HH'");
  });

  it('waits for the code entry screen before reporting that the code was sent', () => {
    const requestAt = assistantSource.indexOf('async requestLoginCode');
    const confirmAt = assistantSource.indexOf('async confirmLoginCode');
    const requestSource = assistantSource.slice(requestAt, confirmAt);
    const applicantStepAt = requestSource.indexOf('account-type-card-APPLICANT');
    const emailMethodAt = requestSource.indexOf('credential-type-email');
    const emailInputAt = requestSource.indexOf('applicant-login-input-email');
    const otpReadyAt = requestSource.indexOf('await waitForHhOtpReady(page)');
    const successAt = requestSource.indexOf("message: 'Код отправлен на почту.'");
    expect(applicantStepAt).toBeGreaterThan(-1);
    expect(emailMethodAt).toBeGreaterThan(-1);
    expect(emailInputAt).toBeGreaterThan(-1);
    expect(otpReadyAt).toBeGreaterThan(applicantStepAt);
    expect(otpReadyAt).toBeGreaterThan(emailMethodAt);
    expect(successAt).toBeGreaterThan(otpReadyAt);
    expect(assistantSource).toContain('[data-qa="applicant-login-input-otp"]');
    expect(assistantSource).toContain('input[data-qa="magritte-pincode-input-field"]');
    expect(requestSource).not.toContain("codeInput.waitFor({ state: 'visible'");
  });

  it('opens the passwordless flow with a post-login resumes destination', () => {
    const requestAt = assistantSource.indexOf('async requestLoginCode');
    const confirmAt = assistantSource.indexOf('async confirmLoginCode', requestAt);
    const requestSource = assistantSource.slice(requestAt, confirmAt);
    expect(assistantSource).toContain(
      'https://hh.ru/account/login?backurl=%2Fapplicant%2Fresumes&role=applicant',
    );
    expect(requestSource).toContain('openFreshHhLoginPage()');
    expect(assistantSource).toContain('loginPage = await context.newPage()');
    expect(assistantSource).toContain('await navigateToHhLogin(loginPage)');
    expect(assistantSource).toContain('isBrokenHhLoginSourcePage(candidateUrl)');
  });

  it('accepts HHs hidden PIN input once it is attached and enabled', () => {
    const helperAt = assistantSource.indexOf('async function waitForHhOtpReady');
    const nextHelperAt = assistantSource.indexOf('async function firstVisibleText', helperAt);
    const helperSource = assistantSource.slice(helperAt, nextHelperAt);
    expect(helperSource).toContain('input.count()');
    expect(helperSource).toContain('input.isEnabled()');
    expect(helperSource).toContain('if (inputEnabled)');
    expect(helperSource).not.toContain("input.waitFor({ state: 'visible'");
  });

  it('confirms login only after HH exposes its durable authenticated cookie', () => {
    const confirmAt = assistantSource.indexOf('async confirmLoginCode');
    const loginRequiredAt = assistantSource.indexOf('private async isLoginRequired', confirmAt);
    const confirmSource = assistantSource.slice(confirmAt, loginRequiredAt);
    const cookieAt = confirmSource.indexOf('await this.hasHhAuthCookie()');
    const successAt = confirmSource.indexOf("message: 'HH подключён.'");
    expect(assistantSource).toContain("const HH_AUTH_COOKIE_NAME = 'crypted_id'");
    expect(cookieAt).toBeGreaterThan(-1);
    expect(successAt).toBeGreaterThan(cookieAt);
  });

  it('types into HHs virtual PIN without a second submit and recovers post-login 404', () => {
    const confirmAt = assistantSource.indexOf('async confirmLoginCode');
    const resumesAt = assistantSource.indexOf('async getApplicantResumes', confirmAt);
    const confirmSource = assistantSource.slice(confirmAt, resumesAt);
    expect(confirmSource).toContain("inputDataQa === 'magritte-pincode-input-field'");
    expect(confirmSource).toContain('(element as HTMLInputElement).focus()');
    expect(confirmSource).toContain("page.keyboard.press('Backspace')");
    expect(confirmSource).toContain('page.keyboard.type(normalized');
    expect(confirmSource).not.toContain('button[type="submit"]');
    expect(confirmSource).toContain("page.url().includes('/404') || page.url().includes('/account/login')");
    expect(confirmSource).toContain("page.goto('https://hh.ru/applicant/resumes'");
  });

  it('loads real resumes through the authenticated browser IPC boundary', () => {
    expect(assistantSource).toContain('async getApplicantResumes()');
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:get-resumes'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:get-resumes')");
    expect(electronTypesSource).toContain('getResumes: () => Promise<Array<');
    expect(pageSource).toContain('setResumes(await assistant.getResumes())');
    expect(pageSource).toContain('resumes.map((resume) => {');
    expect(pageSource).toContain('type="checkbox"');
    expect(pageSource).toContain('draft.resumeTitles.includes(resume.title)');
    expect(pageSource).not.toContain('placeholder="Часть названия резюме"');
  });

  it('does not disguise an HH loading failure as an empty resume list', () => {
    expect(pageSource).not.toContain('.catch(() => setResumes([]))');
    expect(pageSource).toContain('setResumeLoadError(');
    expect(pageSource).toContain('Повторить');
    expect(pageSource).toContain('Загружаю резюме из HH…');
    expect(assistantSource).toContain('this.context.request.get(HH_APPLICANT_RESUMES_URL');
    expect(assistantSource).toContain('await this.resetBrowserConnection()');
  });

  it('closes Chrome gracefully before the taskkill fallback so HH cookies persist', () => {
    const closeAt = assistantSource.indexOf('async close(): Promise<void>');
    const failAt = assistantSource.indexOf('private fail(', closeAt);
    const closeSource = assistantSource.slice(closeAt, failAt);
    expect(closeSource.indexOf('browser.close()')).toBeGreaterThan(-1);
    expect(closeSource.indexOf('terminateBrowserProcessTree(browserProcess)')).toBeGreaterThan(
      closeSource.indexOf('browser.close()'),
    );
  });

  it('keeps search settings hidden until the selected platform is authenticated', () => {
    const gateAt = pageSource.indexOf('{!connected ? (');
    const settingsAt = pageSource.indexOf('Что искать');
    expect(gateAt).toBeGreaterThan(-1);
    expect(settingsAt).toBeGreaterThan(gateAt);
    expect(pageSource).toContain(
      'Сначала откройте выбранную площадку и войдите в аккаунт.',
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

  it('keeps the redesigned compact search, schedule, and found-vacancies UI', () => {
    expect(pageSource).toContain('Что искать');
    expect(pageSource).toContain('Ежедневно в');
    expect(pageSource).toContain('Найденные вакансии');
    expect(pageSource).toContain('overflow-y-auto');
  });

  it('saves settings, scans, and immediately starts the HH queue', () => {
    const actionAt = pageSource.indexOf('const saveAutomation = async () =>');
    const actionEndAt = pageSource.indexOf('const activeQueue', actionAt);
    const actionSource = pageSource.slice(actionAt, actionEndAt);
    const saveAt = actionSource.indexOf('assistant.saveConfig(');
    const scanAt = actionSource.indexOf('assistant.scan(draft.platform)');
    const applyAt = actionSource.indexOf('assistant.applyAll()');

    expect(actionAt).toBeGreaterThan(-1);
    expect(actionEndAt).toBeGreaterThan(actionAt);
    expect(saveAt).toBeGreaterThan(-1);
    expect(scanAt).toBeGreaterThan(saveAt);
    expect(applyAt).toBeGreaterThan(scanAt);
    expect(pageSource).toContain('Найти и запустить автоотклики');
  });

  it('keeps every found vacancy visible, including skips and their reasons', () => {
    expect(pageSource).toContain("filter((item) => item.platform === draft.platform)");
    expect(pageSource).not.toContain("item.status !== 'skipped'");
    expect(pageSource).toContain('{item.reason &&');
    expect(pageSource).toContain('max-h-[60vh]');
    expect(pageSource).toContain('break-words');
  });

  it('exposes manual and background HR message checks in the responses tab', () => {
    expect(pageSource).toContain('Ответы на сообщения HR');
    expect(pageSource).toContain('chat.pollNow()');
    expect(pageSource).toContain('chat.setEnabled(');
    expect(pageSource).toContain('последнее сообщение пришло от работодателя');
  });

  it('keeps chat polling on a dedicated browser page', () => {
    expect(assistantSource).toContain('async getChatPage()');
    expect(mainSource).toContain('hhBrowserAssistant?.getChatPage()');
    expect(mainSource).not.toContain('hhBrowserAssistant?.getPage() ?? null');
  });

  it('opens a fresh automation target instead of a frozen restored Chrome tab', () => {
    expect(assistantSource).toContain('this.page = await context.newPage()');
    expect(assistantSource).toContain('this.page = await existingContext.newPage()');
    expect(assistantSource).not.toContain('this.page = context.pages()[0]');
  });

  it('scopes HH screening-question selectors to the real response flow', () => {
    expect(assistantSource).toContain('hasVisibleResponseFlowBlocker(page)');
    expect(assistantSource).toContain('element.closest(String(containerSelector))');
    expect(assistantSource).not.toContain('await hasVisible(page, RESPONSE_QUESTION_SELECTOR)');
    expect(assistantSource).toContain("case 'open_letter'");
    expect(assistantSource).toContain('ADD_COVER_LETTER_SELECTOR');
  });

  it('states the supported platforms and explains the visible HH login window', () => {
    expect(pageSource).toContain('HH.ru');
    expect(pageSource).toContain('Avito Работа');
    expect(pageSource).toContain('LinkedIn');
    expect(pageSource).toContain("label: 'Avito Работа'");
    expect(pageSource).toContain("label: 'LinkedIn'");
    expect(pageSource).toContain('Откроется отдельное окно HH');
    expect(pageSource).toContain('Почта, привязанная к HH');
  });

  it('advances through the hydrated HH account-type screen before waiting for email', () => {
    const requestAt = assistantSource.indexOf('async requestLoginCode');
    const confirmAt = assistantSource.indexOf('async confirmLoginCode', requestAt);
    const requestSource = assistantSource.slice(requestAt, confirmAt);
    expect(requestSource).toContain("applicantType.waitFor({ state: 'attached'");
    expect(requestSource).toContain('accountSubmit.isEnabled()');
    expect(requestSource).toContain('await accountSubmit.click()');
  });

  it('enables the daily schedule and immediately scans before applying', () => {
    const actionAt = pageSource.indexOf('const saveAutomation = async () =>');
    const actionEndAt = pageSource.indexOf('const activeQueue', actionAt);
    const actionSource = pageSource.slice(actionAt, actionEndAt);
    const saveAt = actionSource.indexOf('assistant.saveConfig(');
    const scheduleAt = actionSource.indexOf('assistant.setDailySchedule(true)');
    const scanAt = actionSource.indexOf('assistant.scan(draft.platform)');
    const applyAt = actionSource.indexOf('assistant.applyAll()');

    expect(actionAt).toBeGreaterThan(-1);
    expect(actionSource).toContain('autoRunDaily: isHh');
    expect(saveAt).toBeGreaterThan(-1);
    expect(scheduleAt).toBeGreaterThan(saveAt);
    expect(scanAt).toBeGreaterThan(scheduleAt);
    expect(applyAt).toBeGreaterThan(scanAt);
    expect(pageSource).toContain('Найти и запустить автоотклики');
    expect(pageSource).toContain("draft.platform === 'hh' && draft.resumeTitles.length === 0");
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
