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
const calendarPageSource = fs.readFileSync(
  path.resolve(__dirname, 'InterviewCalendarPage.tsx'),
  'utf8',
);
const availabilityEditorSource = fs.readFileSync(
  path.resolve(__dirname, '../components/interview/AvailabilityEditor.tsx'),
  'utf8',
);
const calendarCssSource = fs.readFileSync(
  path.resolve(__dirname, '../styles/interview-calendar.css'),
  'utf8',
);
const searchResultsSource = fs.readFileSync(
  path.resolve(__dirname, '../../electron/hhSearchResults.ts'),
  'utf8',
);
const screeningQuestionsSource = fs.readFileSync(
  path.resolve(__dirname, '../../electron/hhScreeningQuestions.ts'),
  'utf8',
);

describe('HH applications redesign', () => {
  it('uses pressed filter buttons instead of incomplete ARIA tabs', () => {
    expect(pageSource).toContain('aria-label="Фильтры вакансий"');
    expect(pageSource).toContain('aria-pressed={queueView === id}');
    expect(pageSource).not.toContain('role="tablist"');
    expect(pageSource).not.toContain('role="tab"');
  });

  it('keeps the daily overview concise and moves run messages into details', () => {
    expect(pageSource).toContain('Последний запуск завершён; результат и история доступны ниже.');
    expect(pageSource).toContain("? 'Нужно завершить настройку поиска'");
    expect(pageSource).toContain('? startRequirement');
    expect(pageSource).toContain("activeRun ? 'Текущий поиск' : 'Последний поиск'");
    expect(pageSource).not.toContain("detail: featuredRun?.message");
  });
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
    expect(pageSource).toContain("hhConnected ? 'HH подключён'");
    expect(pageSource).toContain(": 'Подключите аккаунт HH'");
  });

  it('bounds background HH restore and falls back to the login form', () => {
    expect(pageSource).toContain('const hhRestoreCandidate = Boolean(');
    expect(pageSource).toContain('const hhSessionUnchecked = hhRestoreCandidate && !hhRestoreTimedOut');
    expect(pageSource).toContain('const canLoadHhResumes = hhConnected || hhRestoreCandidate');
    expect(pageSource).toContain('if (!assistant || !canLoadHhResumes)');
    expect(pageSource).toContain('setHhRestoreTimedOut(true), 8_000');
    expect(pageSource).toContain('Проверяю сессию HH');
    expect(pageSource).toContain('!hhConnected && !hhSessionUnchecked');
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
    expect(assistantSource).toContain('closeExcessAutomationPages(new Set([loginPage]))');
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
    expect(pageSource).toContain('const loaded = await assistant.getResumes()');
    expect(pageSource).toContain('setResumes(loaded)');
    expect(pageSource).toContain('Резюме по умолчанию');
    expect(pageSource).toContain('loaded[0] ? [loaded[0].title] : []');
    expect(pageSource).toContain('aria-label="Резюме HH по умолчанию"');
    expect(pageSource).toContain('resumeTitles: [event.target.value]');
    expect(pageSource).not.toContain('placeholder="Часть названия резюме"');
  });

  it('does not disguise an HH loading failure as an empty resume list', () => {
    expect(pageSource).not.toContain('.catch(() => setResumes([]))');
    expect(pageSource).toContain('setResumeLoadError(');
    expect(pageSource).toContain('Повторить');
    expect(pageSource).toContain('Загружаю актуальное резюме из HH…');
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

  it('spreads a large queue across days without discarding the remainder', () => {
    const runQueueAt = assistantSource.indexOf('private async runQueue');
    const applyAllAt = assistantSource.indexOf('async applyAll', runQueueAt);
    const runQueueSource = assistantSource.slice(runQueueAt, applyAllAt);
    expect(runQueueSource).toContain('canSendMore');
    expect(runQueueSource).toContain('dailyLimitReached');
    expect(runQueueSource).toContain('Продолжу автоматически в следующий запуск');
    expect(runQueueSource).not.toContain('delayBetweenSec');
    expect(runQueueSource).not.toContain('setTimeout');
  });

  it('keeps the redesigned compact search, schedule, and found-vacancies UI', () => {
    expect(pageSource).toContain('Что искать');
    expect(pageSource).toContain('Каждый день');
    expect(pageSource).toContain('Найти и добавить в очередь');
    expect(pageSource).toContain('Поиск вакансий');
    expect(pageSource).toContain('Предыдущих запусков:');
    expect(pageSource).toContain('Вакансии в работе');
    expect(pageSource).toContain('{queuePanelMeta.title}');
    expect(pageSource).not.toContain('overflow-y-auto');
    expect(pageSource).not.toContain('max-h-[60vh]');
    expect(pageSource).toContain('hh-run-progress');
    expect(pageSource).toContain('hh-daily-overview');
    expect(pageSource).toContain('aria-label="Разделы откликов"');
    expect(pageSource).toContain("const [pageMode, setPageMode] = useState<'activity' | 'settings'>(");
    expect(pageSource).toContain("pageMode === 'activity'");
    expect(pageSource).toContain("pageMode === 'settings'");
    expect(pageSource).toContain('hh-launch-panel');
    expect(pageSource).toContain('hh-run-mode-selector');
    expect(pageSource).toContain('Сохранить настройки');
    expect(pageSource).not.toContain('const [settingsOpen');
  });

  it('opens a vacancy as a regular external link even when HH automation is disconnected', () => {
    expect(pageSource).toContain('const openVacancyInBrowser');
    expect(pageSource).toContain('window.electronAPI?.openExternal(vacancy.url)');
    const queueAt = pageSource.indexOf('shownQueue.map((item) =>');
    expect(queueAt).toBeGreaterThan(-1);
    const queueSource = pageSource.slice(queueAt);
    expect(queueSource).toContain('onClick={() => openVacancyInBrowser(item)}');
    expect(queueSource).toContain('<ExternalLink size={14} />Открыть</button>');
    expect(queueSource).not.toContain("run('open', () => assistant.openVacancy(item.key))");
  });

  it('shows only the concise role and salary for the selected résumé', () => {
    expect(pageSource).toContain('compactHhResumeTitle(item.selectedResumeTitle)');
    expect(pageSource).not.toContain('<FileText size={12} />{item.selectedResumeTitle}</p>');
  });

  it('filters description-only profession matches and continues the full saved queue', () => {
    expect(assistantSource).toContain('isVacancyRelevantToSearchQuery(vacancy, searchQuery)');
    expect(assistantSource).toContain("reason: 'Не соответствует названию выбранной роли.'");
    expect(assistantSource).toContain('scopedKeys?: ReadonlySet<string>');
    expect(assistantSource).toContain('await this.runQueue(run.id)');
    expect(assistantSource).toContain("this.beginRun('resume')");
  });

  it('separates HH responded search cards from newly sent applications', () => {
    expect(searchResultsSource).toContain('vacancy-serp__vacancy_responded');
    expect(assistantSource).toContain("'already_applied'");
    expect(assistantSource).toContain('не считаю его новым');
  });

  it('saves settings and immediately runs one observable search transaction', () => {
    const actionAt = pageSource.indexOf('const saveAutomation = async () =>');
    const actionEndAt = pageSource.indexOf('const activeQueue', actionAt);
    const actionSource = pageSource.slice(actionAt, actionEndAt);
    const saveAt = actionSource.indexOf('assistant.saveConfig(');
    const runNowAt = actionSource.indexOf('assistant.runNow()');

    expect(actionAt).toBeGreaterThan(-1);
    expect(actionEndAt).toBeGreaterThan(actionAt);
    expect(saveAt).toBeGreaterThan(-1);
    expect(runNowAt).toBeGreaterThan(saveAt);
    expect(pageSource).toContain('Проверять вручную');
    expect(pageSource).toContain('Стоп на неизвестном вопросе');
    expect(pageSource).toContain('Найти и отправить отклики');
  });

  it('shows the current search stage after the start button is pressed', () => {
    expect(pageSource).toContain("const searchLaunchBusy = busy === 'save' || Boolean(activeRun)");
    expect(pageSource).toContain('Запускаем поиск…');
    expect(pageSource).toContain('Ищем вакансии…');
    expect(pageSource).toContain('Обрабатываем отклики…');
    expect(pageSource).toContain('aria-busy={stoppingRun}');
    expect(pageSource).toContain('? <button type="button" className="btn-danger"');
    expect(pageSource).toContain('aria-live="polite"');
    expect(mainSource).toContain("void hhBrowserAssistant.runNow('manual')");
    expect(mainSource).toContain('return hhBrowserAssistant.getState()');
  });

  it('lets the user stop both scanning and applying without an automatic queue restart', () => {
    expect(pageSource).toContain('assistant.stopApply()');
    expect(pageSource).toContain("onClick={() => void stopAutomation()}");
    expect(pageSource).toContain("'Остановить'");
    expect(pageSource).toContain('Останавливаем…');
    expect(pageSource).toContain('Очередь приостановлена');
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:stop-apply'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:stop-apply')");
    expect(electronTypesSource).toContain('stopRequested: boolean');
    expect(electronTypesSource).toContain('queuePaused: boolean');
    expect(electronTypesSource).toContain("| 'stopped'");

    const scanAt = assistantSource.indexOf('async scan(');
    const applyAt = assistantSource.indexOf('private async runQueue', scanAt);
    const scanSource = assistantSource.slice(scanAt, applyAt);
    expect(scanSource).toContain('scanLoop: while');
    expect(scanSource).toContain('if (this.stopApplyRequested) break scanLoop');

    const runQueueAt = assistantSource.indexOf('private async runQueue');
    const applyAllAt = assistantSource.indexOf('async applyAll', runQueueAt);
    const runQueueSource = assistantSource.slice(runQueueAt, applyAllAt);
    expect(runQueueSource).toContain('const stopped = this.stopApplyRequested');
    expect(runQueueSource).toContain('!hardBlocked && !stopped');
    expect(runQueueSource).toContain('queuePaused: stopped || this.state.queuePaused');

    const stopAt = assistantSource.indexOf('stopApply(): HhAssistantState');
    const pendingAt = assistantSource.indexOf('private pendingQueueCount', stopAt);
    const stopSource = assistantSource.slice(stopAt, pendingAt);
    expect(stopSource).toContain('this.clearQueueResumeTimer()');
    expect(stopSource).toContain('queuePaused: true');
    expect(assistantSource).toContain('|| this.state.queuePaused');
  });

  it('explains and navigates to missing auto-apply requirements instead of silently disabling start', () => {
    expect(pageSource).toContain('const startRequirement = useMemo(');
    expect(pageSource).toContain('{startRequirement}<button type="button" onClick={focusMissingRequirement}>Исправить</button>');
    expect(pageSource).toContain("target?.scrollIntoView({ behavior: 'smooth', block: 'center' })");
    expect(pageSource).toContain('onClick={focusMissingRequirement}');
    expect(pageSource).toContain('Исправить');
    expect(pageSource).toContain('loaded[0] ? [loaded[0].title] : []');
    expect(pageSource).toContain('disabled={busy !== \'\'}');
    expect(pageSource).not.toContain("disabled={busy !== '' || !draft.query.trim()");
  });

  it('never lets the required search step collapse out of view', () => {
    expect(pageSource).toContain('id="hh-search-settings"');
    expect(pageSource).toContain("setPageMode('settings')");
    expect(pageSource).toContain('Обязательный шаг');
    expect(pageSource).toContain('Должность или поисковый запрос');
    expect(pageSource).toContain('aria-required="true"');
    expect(pageSource).toContain('setShowSearchRequirement(!missingConnection && !missingResume && !draft.query.trim())');
    expect(pageSource).toContain('Любой — максимум вакансий');
    expect(pageSource).toContain('Искать близкие названия роли');
    expect(pageSource).toContain('Дополнительные направления');
    expect(pageSource).toContain('дубликаты между запросами удаляются');
    const advancedAt = pageSource.indexOf('{showAdvanced &&');
    expect(advancedAt).toBeGreaterThan(-1);
    expect(pageSource.indexOf('<span className="label">Регион</span>')).toBeGreaterThan(advancedAt);
  });

  it('notifies the hidden overlay to clear a finished recap before a new opening', () => {
    expect(mainSource).toContain("win.webContents.send('overlay:open-requested')");
    expect(preloadSource).toContain("ipcRenderer.on('overlay:open-requested', handler)");
    expect(electronTypesSource).toContain('onOpenRequested?: (cb: () => void) => () => void');
  });

  it('keeps every found vacancy reachable without a nested scroll area', () => {
    expect(pageSource).toContain("filter((item) => item.platform === draft.platform)");
    expect(pageSource).not.toContain("item.status !== 'skipped'");
    expect(pageSource).toContain('{item.reason &&');
    expect(pageSource).not.toContain('max-h-[60vh]');
    expect(pageSource).not.toContain('overflow-y-auto');
    expect(pageSource).toContain('setVisibleLimit((limit) => limit + 25)');
    expect(pageSource).toContain('Показать ещё');
    expect(pageSource).toContain('break-words');
  });

  it('exposes manual and background HR message checks in the responses tab', () => {
    expect(pageSource).toContain('Диалоги HR');
    expect(pageSource).toContain('chat.pollNow()');
    expect(pageSource).toContain('chat.setEnabled(');
    expect(pageSource).toContain("chatState?.enabled ? 'Автоответы включены'");
    expect(pageSource).toContain("queueView === 'dialogs'");
    expect(pageSource).toContain('onClick={emptyQueueCopy.action}');
    expect(pageSource).toContain("chat && hhConnected && (chatState?.pendingDecisions.length ?? 0) > 0");
    expect(pageSource).toContain("['replies', 'Ответы', chatState?.replyHistory.length ?? 0]");
    expect(pageSource).toContain('Сообщение HR');
    expect(pageSource).toContain('Ответ от вашего имени');
    expect(pageSource).toContain('entry.recruiterMessage');
    expect(pageSource).toContain('entry.reply');
    expect(pageSource).toContain('Ответы сегодня:');
    expect(pageSource).toContain("openExternal('https://hh.ru/applicant/negotiations')");
    expect(pageSource).toContain('aria-expanded={expanded}');
    expect(pageSource).toContain('Сообщение работодателя');
    expect(mainSource).toContain('signal: AbortSignal.timeout(20_000)');
  });

  it('configures interview availability inline before enabling HR replies', () => {
    expect(pageSource).toContain('Когда можно назначать созвоны');
    expect(pageSource).toContain('setAvailabilityOpen(true)');
    expect(pageSource).toContain('calendar.saveSettings(settings)');
    expect(pageSource).toContain('chat.setEnabled(true)');
    expect(pageSource).toContain('Сохранить и включить автоответы');
    expect(availabilityEditorSource).toContain('Будни 10–18');
    expect(availabilityEditorSource).toContain('Будни после 18');
    expect(availabilityEditorSource).toContain('Только выходные');
    expect(availabilityEditorSource).toContain('Повторить этот день:');
    expect(availabilityEditorSource).toContain('Вся неделя');
    expect(availabilityEditorSource).not.toContain('Сколько времени оставить на один созвон?');
    expect(availabilityEditorSource).not.toContain('setDurationMin');
    expect(availabilityEditorSource).toContain('formatTimezoneDisplay(settings.timezone)');
    expect(calendarPageSource).toContain("from '../components/interview/AvailabilityEditor'");
    expect(calendarPageSource).toContain('const [availabilityOpen, setAvailabilityOpen]');
    expect(calendarPageSource).toContain('setAvailabilityOpen(false)');
    expect(calendarPageSource).toContain("availabilityOpen ? 'Свернуть'");
    expect(calendarPageSource).toContain('formatAvailabilitySummary(state.settings)');
  });

  it('creates a calendar event from the exact free time the user clicks', () => {
    expect(calendarPageSource).toContain('const CALENDAR_SLOT_MINUTES = 30');
    expect(calendarPageSource).toContain('calendarGridBounds(');
    expect(calendarPageSource).toContain('state.settings.availability');
    expect(calendarPageSource).toContain('const openEventAt = (day: Date, minutes: number, durationMin?: number) =>');
    expect(calendarPageSource).toContain('onPointerDown={(event) => beginSlotSelection(dayIndex, slotIndex, event)}');
    expect(calendarPageSource).toContain('onPointerEnter={() => extendSlotSelection(dayIndex, slotIndex)}');
    expect(calendarPageSource).toContain('interview-week-selection');
    expect(calendarPageSource).toContain('interview-week-slot__hint');
    expect(calendarPageSource).toContain(': form ? formatFull(form.startAt) :');
    expect(calendarPageSource).toContain('<span className="label">Окончание</span>');
    expect(calendarCssSource).toContain('.interview-week-slot:hover');
    expect(calendarCssSource).toContain('min-width: 786px');
    expect(calendarCssSource).toContain('overflow-y: hidden');
    expect(calendarCssSource).not.toContain('max-height: 620px');
    expect(calendarCssSource).toContain('transform: translateY(0) scale(1)');
    expect(calendarCssSource).toMatch(
      /\.interview-week-slot\.is-selecting \.interview-week-slot__hint\s*\{[^}]*visibility:\s*hidden/s,
    );
    expect(calendarCssSource).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('can start, review, and delete the same linked interview from the calendar', () => {
    expect(calendarPageSource).toContain('overlay.showForInterviewEvent');
    expect(calendarPageSource).toContain('const started = await launch(event.id)');
    expect(calendarPageSource).toContain('Прошедшие созвоны');
    expect(calendarPageSource).toContain('function InterviewOutcomeView');
    expect(calendarPageSource).toContain('setEventToDelete(event)');
    expect(calendarPageSource).toContain('calendar.removeEvent(event.id)');
    expect(calendarPageSource).not.toContain('window.confirm');
  });

  it('keeps chat polling on a dedicated browser page', () => {
    expect(assistantSource).toContain('async getChatPage(options: { explicit?: boolean } = {})');
    expect(mainSource).toContain("hhBrowserAssistant?.getChatPage({ explicit: purpose === 'explicit' })");
    expect(mainSource).not.toContain('hhBrowserAssistant?.getPage() ?? null');
  });

  it('opens a fresh automation target instead of a frozen restored Chrome tab', () => {
    expect(assistantSource).toContain('this.page = await context.newPage()');
    expect(assistantSource).toContain('this.page = await existingContext.newPage()');
    expect(assistantSource).not.toContain('this.page = context.pages()[0]');
  });

  it('keeps automation headless and prevents parallel blank-tab leaks', () => {
    const argsAt = assistantSource.indexOf('export function browserLaunchArguments');
    const allocateAt = assistantSource.indexOf('async function allocateDebugPort', argsAt);
    const argsSource = assistantSource.slice(argsAt, allocateAt);
    const launchAt = assistantSource.indexOf('private async launchInstalledBrowser');
    const cleanupAt = assistantSource.indexOf('private async closeExcessAutomationPages', launchAt);
    const launchSource = assistantSource.slice(launchAt, cleanupAt);

    expect(argsSource).toContain("args.push('--headless=new'");
    expect(argsSource).toContain("mode === 'background'");
    expect(launchSource).toContain('windowsHide: true');
    expect(launchSource).not.toContain("'about:blank'");
    expect(assistantSource).toContain('private ensureBrowserPromise: Promise<Page> | null');
    expect(assistantSource).toContain('private chatPagePromise: Promise<Page | null> | null');
    expect(assistantSource).toContain('closeExcessAutomationPages');
    expect(assistantSource).toContain('await settleWithin(candidate.close(), 1_500)');
    expect(assistantSource).toContain('terminateOrphanedProfileBrowsers(this.profileDir)');
    expect(assistantSource).toContain('SKILLCUE_AUTOMATION_PROFILE');
    expect(assistantSource.match(/await terminateOrphanedProfileBrowsers\(this\.profileDir\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(assistantSource).toContain('await this.closeExcessAutomationPages(new Set([this.page');
  });

  it('scopes HH screening-question selectors to the real response flow', () => {
    expect(assistantSource).toContain('hasVisibleResponseFlowBlocker(page)');
    expect(assistantSource).toContain('element.closest(String(containerSelector))');
    expect(assistantSource).not.toContain('await hasVisible(page, RESPONSE_QUESTION_SELECTOR)');
    expect(assistantSource).toContain('[data-qa="task-question"]');
    expect(assistantSource).toContain('form[name="vacancy_response"] [name^="task_"]');
    expect(assistantSource).toContain('[data-qa="employer-asking-for-test"]');
    expect(screeningQuestionsSource).toContain("control.closest('[data-qa=\"task-body\"]')");
    expect(screeningQuestionsSource).toContain("querySelector('[data-qa=\"task-question\"]')");
    expect(screeningQuestionsSource.indexOf('const taskPrompt')).toBeLessThan(
      screeningQuestionsSource.indexOf('const labelledBy'),
    );
    expect(screeningQuestionsSource).toContain("control.locator('xpath=ancestor::label[1]')");
    expect(screeningQuestionsSource).toContain("label.click({ timeout: 5_000 })");
    expect(screeningQuestionsSource).toContain('return fields.slice(0, 60)');
    expect(assistantSource).toContain("case 'open_letter'");
    expect(assistantSource).toContain('ADD_COVER_LETTER_SELECTOR');
    expect(assistantSource).toContain('[data-qa="vacancy-response-letter-toggle"]');
    expect(assistantSource).toContain('[data-qa="open-vacancy-chat"]');
    expect(assistantSource).toContain('[data-qa="chatik-chat-message-applicant-action"]');
    expect(assistantSource).toContain('[data-qa="chat-input-preview"]');
    expect(assistantSource).toContain('[data-qa="chatik-new-message-text"]');
    expect(assistantSource).toContain('[data-qa="chatik-do-send-message"]');
    expect(assistantSource).toContain('private async attachPendingCoverLetterInChat(');
    expect(assistantSource).toContain('private async openVacancyChatFromNegotiations(');
    expect(assistantSource).toContain('pageIndex < 21');
    expect(assistantSource).toContain('[data-qa="open_chat"]');
    expect(assistantSource).toContain('negotiations-item-discard');
    expect(assistantSource).toContain('Работодатель уже отказал по этой вакансии');
    expect(assistantSource).toContain('HH не подтвердил отправку отклика. Возвращаю вакансию в очередь');
    expect(assistantSource).toContain("button.click({ timeout: 5_000, force: true })");
    expect(assistantSource).toContain("addLetter.click({ timeout: 5_000, force: true })");
    expect(assistantSource).toContain('HH не подтвердил появление сопроводительного письма в чате');
    expect(assistantSource).toContain('return this.finishPendingCoverLetter(page, vacancy)');
    expect(assistantSource).not.toContain('renderCoverLetter(this.state.config.coverLetterTemplate, vacancy)');
    expect(assistantSource).toContain('Персональное письмо сейчас недоступно');
    expect(assistantSource).toContain('timeout: 5_000');
    expect(assistantSource).toContain('Дожидаюсь формы сопроводительного письма');
    expect(assistantSource).toContain('coverLetterPending: true');
    expect(assistantSource).toContain('Отклик и сопроводительное письмо отправлены');
    expect(assistantSource).not.toContain('Отклик отправлен без письма');
    expect(mainSource).toContain('signal: AbortSignal.timeout(12_000)');
    const letterFormAt = assistantSource.indexOf("return 'letter_form'", assistantSource.indexOf('private async detectApplySituation'));
    const employerQuestionsAt = assistantSource.indexOf("return 'employer_questions'", assistantSource.indexOf('private async detectApplySituation'));
    const successAt = assistantSource.indexOf("return 'success'", assistantSource.indexOf('private async detectApplySituation'));
    expect(assistantSource).toContain('!ctx.questionsFilled && (await hasVisibleResponseFlowBlocker(page))');
    expect(employerQuestionsAt).toBeGreaterThan(-1);
    expect(employerQuestionsAt).toBeLessThan(letterFormAt);
    expect(letterFormAt).toBeGreaterThan(-1);
    expect(letterFormAt).toBeLessThan(successAt);
  });

  it('lets a delayed post-response letter form win over the already-applied state', () => {
    const detectAt = assistantSource.indexOf('private async detectApplySituation');
    const selectAt = assistantSource.indexOf('private async selectPreferredResume', detectAt);
    const detectSource = assistantSource.slice(detectAt, selectAt);
    expect(assistantSource).toContain('[data-qa="vacancy-response-link-top-again"]');
    expect(assistantSource).toContain("'вы откликнулись'");
    expect(detectSource.indexOf("return 'already_applied'")).toBeGreaterThan(-1);
    expect(detectSource.indexOf("return 'letter_form'")).toBeLessThan(
      detectSource.indexOf("return 'already_applied'"),
    );
    expect(detectSource).toContain("? 'post_response_letter_offer'");
    expect(detectSource.indexOf("return 'already_applied'")).toBeLessThan(
      detectSource.indexOf("return 'unknown'"),
    );
  });

  it('pauses only the vacancy with an unknown employer question and resumes it after confirmation', () => {
    expect(assistantSource).toContain("'needs_input'");
    expect(assistantSource).toContain('pendingQuestions: result.pendingQuestions');
    expect(assistantSource).toContain('async answerScreeningQuestions(');
    expect(assistantSource).toContain('screeningQuestionSemanticKey(answer.question)');
    expect(pageSource).toContain('Вопросы работодателей');
    expect(pageSource).toContain('Остальная очередь продолжает работать');
    expect(pageSource).toContain('Заполнить на HH и продолжить отклик');
    expect(pageSource).toContain('Запомнить мои ответы');
    expect(pageSource).toContain('Что SkillCue запомнил');
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:answer-screening-questions'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:answer-screening-questions'");
    expect(electronTypesSource).toContain('screeningFacts: HhScreeningFact[]');
    expect(pageSource).toContain('item.preparationNotes');
    expect(assistantSource).toContain('preparationNotes?: string[]');
    expect(mainSource).toContain('Перед интервью повторите:');
  });

  it('states the supported platforms without the removed background-login note', () => {
    expect(pageSource).toContain('HH.ru');
    expect(pageSource).toContain('Avito Работа');
    expect(pageSource).toContain('LinkedIn');
    expect(pageSource).toContain("label: 'Avito Работа'");
    expect(pageSource).toContain("label: 'LinkedIn'");
    expect(pageSource).not.toContain('SkillCue подключит HH в фоне: отдельное окно не откроется');
    expect(pageSource).toContain('Почта аккаунта HH');
  });

  it('advances through the hydrated HH account-type screen before waiting for email', () => {
    const requestAt = assistantSource.indexOf('async requestLoginCode');
    const confirmAt = assistantSource.indexOf('async confirmLoginCode', requestAt);
    const requestSource = assistantSource.slice(requestAt, confirmAt);
    expect(requestSource).toContain("applicantType.waitFor({ state: 'attached'");
    expect(requestSource).toContain('accountSubmit.isEnabled()');
    expect(requestSource).toContain('await accountSubmit.click()');
  });

  it('keeps immediate launch separate from the optional daily schedule', () => {
    const actionAt = pageSource.indexOf('const saveAutomation = async () =>');
    const actionEndAt = pageSource.indexOf('const activeQueue', actionAt);
    const actionSource = pageSource.slice(actionAt, actionEndAt);
    const saveAt = actionSource.indexOf('assistant.saveConfig(');
    const runNowAt = actionSource.indexOf('assistant.runNow()');

    expect(actionAt).toBeGreaterThan(-1);
    expect(saveAt).toBeGreaterThan(-1);
    expect(runNowAt).toBeGreaterThan(saveAt);
    expect(pageSource).toContain('Каждый день');
    expect(pageSource).toContain('Следующий:');
    expect(pageSource).toContain('saveSettingsOnly');
    expect(pageSource).toContain('Сохранить настройки');
    expect(pageSource).toContain('state.config.autoRunDaily !== draft.autoRunDaily');
    expect(pageSource).toContain("if (draft.resumeTitles.length === 0) return 'Выберите хотя бы одно резюме в шаге 1.'");
  });

  it('accepts a concrete HH vacancy link and records every run outcome', () => {
    expect(pageSource).toContain('Есть конкретная вакансия?');
    expect(pageSource).toContain('assistant.applyVacancyUrl(normalized)');
    expect(pageSource).toContain('Разобрать');
    expect(pageSource).toContain('Отправить сразу');
    expect(pageSource).toContain("platformRuns.find((item) => item.status === 'running')");
    expect(pageSource).toContain('{featuredRun.found} найдено');
    expect(pageSource).toContain('aria-label="Собрать диагностику запуска"');
    expect(assistantSource).toContain('async applyVacancyUrl(rawUrl: string)');
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:apply-vacancy-url'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:apply-vacancy-url', url)");
    expect(electronTypesSource).toContain('runHistory: HhAutomationRun[]');
    expect(mainSource).toContain("path.join(dir, 'hh-automation.json')");
  });

  it('reads a search page as one snapshot and reports live progress', () => {
    const scrapeAt = assistantSource.indexOf('private async scrapeCurrentPage');
    const scanAt = assistantSource.indexOf('async scan(', scrapeAt);
    const scrapeSource = assistantSource.slice(scrapeAt, scanAt);
    expect(scrapeSource).toContain('parseHhSearchResults(await page.content(), 100)');
    expect(scrapeSource).not.toContain('.innerText()');
    expect(searchResultsSource).toContain('Missing optional fields');
    expect(assistantSource).toContain('private automationRunInFlight = false');
    expect(assistantSource).toContain('Ищу вакансии: страница ${pageIndex + 1} из ${pagesToScan}');
    expect(assistantSource).toContain('this.progressRun(runId');
    expect(assistantSource).toContain('Проверено ${done} из ${total} · отправлено сейчас ${sentNow} · уже было ${alreadyAppliedNow}');
    expect(assistantSource).toContain('await candidate.click({ timeout: 5_000 })');
    expect(assistantSource).toContain('private async openResponseForm(page: Page)');
    expect(assistantSource).toContain("target.pathname !== '/applicant/vacancy_response'");
    expect(assistantSource).toContain('const clicked = await this.openResponseForm(page)');
    expect(assistantSource).toContain('if (repeatedSituation >= 2)');
    expect(assistantSource).toContain('HH не изменил форму после нескольких попыток');
  });

  it('keeps activity readable when a platform session is temporarily disconnected', () => {
    const connectionGateAt = pageSource.indexOf('{!connected ? (');
    const activityAt = pageSource.indexOf("{pageMode === 'activity' && <>", connectionGateAt);
    const runPanelAt = pageSource.indexOf('id="hh-run-panel"', activityAt);
    const queuePanelAt = pageSource.indexOf('id="hh-conversations-panel"', activityAt);
    expect(connectionGateAt).toBeGreaterThan(-1);
    expect(activityAt).toBeGreaterThan(connectionGateAt);
    expect(runPanelAt).toBeGreaterThan(activityAt);
    expect(queuePanelAt).toBeGreaterThan(runPanelAt);
    expect(pageSource).toContain("if (!connected) return `Подключите ${PLATFORMS.find");
    expect(pageSource).toContain("missingConnection ? 'hh-platform-connection'");
  });

  it('reduces the vacancy navigation to five user-facing stages', () => {
    expect(pageSource).toContain("['active', 'В работе', activeVacancyCount]");
    expect(pageSource).toContain("['sent', 'Отправлено', sentVacancyCount]");
    expect(pageSource).toContain("['dialogs', 'Диалоги', conversationCount]");
    expect(pageSource).toContain("['replies', 'Ответы', chatState?.replyHistory.length ?? 0]");
    expect(pageSource).toContain("['archive', 'Пропущено', archivedVacancyCount]");
    expect(pageSource).not.toContain("['all', 'Все', activeQueue.length]");
    expect(pageSource).not.toContain("['already', 'Уже откликались'");
    expect(pageSource).toContain("queueView === 'dialogs'");
    expect(pageSource).toContain("conversationStage === 'all' || item.stage === conversationStage");
  });

  it('keeps the work view actionable instead of turning counts into visual noise', () => {
    expect(pageSource).toContain('pendingScreeningVacancyCount + pendingHrDecisions');
    expect(pageSource).toContain('countUnansweredHhScreeningQuestions(screeningSummary, screeningDrafts)');
    expect(pageSource).toContain("queueView === 'active' && draft.platform === 'hh'");
    expect(pageSource).toContain('Очередь в работе пуста');
    expect(pageSource).toContain('Проверить сообщения');
    expect(pageSource).toContain("pendingHrDecisions > 0");
    expect(pageSource.indexOf('pendingHrDecisions > 0')).toBeLessThan(pageSource.indexOf('pendingScreeningQuestions > 0', pageSource.indexOf('const overview')));
  });

  it('scopes counters, chats, and run history to the selected platform', () => {
    expect(pageSource).toContain('const todaySent = sentToday(activeQueue)');
    expect(pageSource).not.toContain('sentToday(state?.queue ?? [])');
    expect(pageSource).toContain("item.platform === draft.platform");
    expect(pageSource).toContain("item.platform === draft.platform),");
    expect(pageSource).toContain("draft.platform !== 'hh' && (queueView === 'dialogs' || queueView === 'replies')");
    expect(assistantSource).toContain('platform: this.state.config.platform');
    expect(assistantSource).toContain('platform: normalizePlatform(item.platform)');
    expect(electronTypesSource).toContain("platform: 'hh' | 'linkedin' | 'avito';");
  });

  it('counts and resumes only the HH queue after an HH application run', () => {
    const remainingAt = assistantSource.indexOf('const remaining = this.state.queue.filter(');
    const updateAt = assistantSource.indexOf('this.update({', remainingAt);
    const remainingSource = assistantSource.slice(remainingAt, updateAt);
    expect(remainingSource).toContain("item.platform === 'hh'");
    expect(remainingSource).toContain('isActionableQueueItem(item)');
    expect(assistantSource).toContain('item.coverLetterPending && !item.coverLetterAdded');
    expect(assistantSource).toContain('!onlyFinishingAcceptedResponse && !canSendMore');
    expect(assistantSource).toContain('if (remaining > 0 && !hardBlocked && !stopped) this.scheduleQueueResume');
  });

  it('keeps legacy resume selection while ranking among newly selected resumes', () => {
    expect(electronTypesSource).toContain('resumeTitles: string[]');
    expect(assistantSource).toContain('selectedTitles: string[], vacancyTitle: string');
    expect(assistantSource).toContain('this.state.config.resumeTitles.length > 0');
    expect(assistantSource).toContain('[this.state.config.resumeTitleContains].filter(Boolean)');
    expect(assistantSource).toContain('score > best.score');
  });
});
