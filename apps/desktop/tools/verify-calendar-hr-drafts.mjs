import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const executablePath = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Programs',
  'skillcue-dev',
  'SkillCue Dev.exe',
);
const outputDir = path.resolve(process.cwd(), '..', '..', 'output', 'playwright');
fs.mkdirSync(outputDir, { recursive: true });

if (!fs.existsSync(executablePath)) {
  throw new Error(`Installed SkillCue Dev executable was not found: ${executablePath}`);
}

const app = await electron.launch({ executablePath, timeout: 30_000 });
let main;
let originalChatEnabled = false;

try {
  main = app.windows().find((page) => !page.url().includes('#/overlay'))
    ?? await app.waitForEvent('window', {
      predicate: (page) => !page.url().includes('#/overlay'),
      timeout: 10_000,
    });
  await main.waitForLoadState('domcontentloaded');

  const beforeDrafts = await main.evaluate(async () => {
    const chat = window.electronAPI?.hhChat;
    if (!chat) throw new Error('HH chat API is unavailable.');
    const state = await chat.getState();
    await chat.setEnabled(false);
    return {
      enabled: state.enabled,
      repliesToday: state.repliesToday,
      replyHistoryCount: state.replyHistory.length,
      pendingIds: state.pendingDecisions.map((decision) => decision.id),
    };
  });
  originalChatEnabled = beforeDrafts.enabled;

  await main.evaluate(() => { window.location.hash = '#/calendar'; });
  await main.getByRole('heading', { name: 'Календарь собеседований' }).waitFor({ timeout: 20_000 });
  const week = main.locator('.interview-week-scroll');
  await week.waitFor({ state: 'visible', timeout: 10_000 });
  const scrollOwner = week.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " overflow-y-auto ")][1]',
  );
  const beforeWheel = await Promise.all([
    scrollOwner.evaluate((node) => node.scrollTop),
    week.evaluate((node) => node.scrollTop),
  ]);
  await week.hover();
  await main.mouse.wheel(0, 620);
  await main.waitForTimeout(350);
  const afterWheel = await Promise.all([
    scrollOwner.evaluate((node) => node.scrollTop),
    week.evaluate((node) => node.scrollTop),
  ]);
  if (afterWheel[0] <= beforeWheel[0] + 80) {
    throw new Error(`Vertical wheel did not reach the Calendar page: ${JSON.stringify({ beforeWheel, afterWheel })}`);
  }
  if (afterWheel[1] !== beforeWheel[1]) {
    throw new Error(`The weekly grid scrolled vertically: ${JSON.stringify({ beforeWheel, afterWheel })}`);
  }

  await main.getByRole('button', { name: 'Следующая неделя' }).click();
  await main.getByRole('button', { name: 'Предыдущая неделя' }).click();
  const calendarScreenshot = path.join(outputDir, 'calendar-wheel-installed-dev.png');
  await main.screenshot({ path: calendarScreenshot });

  await main.evaluate(() => { window.location.hash = '#/applications?view=dialogs&focus=hr-decisions'; });
  await main.getByText('Диалоги HR', { exact: true }).waitFor({ timeout: 20_000 });
  const draftDeadline = Date.now() + 65_000;
  let afterDrafts;
  let draftUiSnapshot;
  while (Date.now() < draftDeadline) {
    afterDrafts = await main.evaluate(async () => {
      const state = await window.electronAPI.hhChat.getState();
      return {
        repliesToday: state.repliesToday,
        replyHistoryCount: state.replyHistory.length,
        pendingIds: state.pendingDecisions.map((decision) => decision.id),
        suggestionsReady: state.pendingDecisions.filter((decision) => decision.suggestedAnswer?.trim()).length,
      };
    });
    draftUiSnapshot = await main.locator('#hh-hr-responses textarea').evaluateAll((fields) => ({
      count: fields.length,
      nonEmpty: fields.filter((field) => field.value.trim().length > 0).length,
    }));
    if (
      afterDrafts.pendingIds.length === beforeDrafts.pendingIds.length
      && afterDrafts.suggestionsReady === beforeDrafts.pendingIds.length
      && draftUiSnapshot.count === beforeDrafts.pendingIds.length
      && draftUiSnapshot.nonEmpty === beforeDrafts.pendingIds.length
    ) break;
    await main.waitForTimeout(500);
  }
  if (
    !afterDrafts
    || !draftUiSnapshot
    || afterDrafts.suggestionsReady !== beforeDrafts.pendingIds.length
    || draftUiSnapshot.nonEmpty !== beforeDrafts.pendingIds.length
  ) {
    throw new Error(`HR drafts were not ready in time: ${JSON.stringify({
      expected: beforeDrafts.pendingIds.length,
      persisted: afterDrafts?.suggestionsReady ?? 0,
      rendered: draftUiSnapshot?.nonEmpty ?? 0,
    })}`);
  }
  if (afterDrafts.repliesToday !== beforeDrafts.repliesToday) {
    throw new Error(`Draft preparation changed the sent-today counter: ${JSON.stringify({ beforeDrafts, afterDrafts })}`);
  }
  if (afterDrafts.replyHistoryCount !== beforeDrafts.replyHistoryCount) {
    throw new Error(`Draft preparation added an outbound reply: ${JSON.stringify({ beforeDrafts, afterDrafts })}`);
  }
  if (afterDrafts.pendingIds.join('\0') !== beforeDrafts.pendingIds.join('\0')) {
    throw new Error(`Draft preparation removed or reordered pending decisions: ${JSON.stringify({ beforeDrafts, afterDrafts })}`);
  }

  const textareas = main.locator('#hh-hr-responses textarea');
  const textareaCount = await textareas.count();
  if (textareaCount !== beforeDrafts.pendingIds.length) {
    throw new Error(`Expected ${beforeDrafts.pendingIds.length} HR draft fields, found ${textareaCount}.`);
  }
  for (let index = 0; index < textareaCount; index += 1) {
    if (!(await textareas.nth(index).inputValue()).trim()) {
      throw new Error(`HR draft ${index + 1} is empty.`);
    }
  }

  const editedValue = 'Проверенный пользователем черновик — не отправлять во время проверки.';
  await textareas.first().fill(editedValue);
  await main.waitForTimeout(10_500);
  if (await textareas.first().inputValue() !== editedValue) {
    throw new Error('Background state refresh overwrote the edited HR draft.');
  }

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.getURL().includes('#/overlay'));
    win?.setSize(1120, 760);
  });
  await main.waitForTimeout(400);
  await textareas.first().scrollIntoViewIfNeeded();
  const fit = await main.evaluate(() => {
    const section = document.querySelector('#hh-hr-responses');
    const textarea = section?.querySelector('textarea');
    const sectionRect = section?.getBoundingClientRect();
    const textareaRect = textarea?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      page: {
        width: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      section: sectionRect ? { left: sectionRect.left, right: sectionRect.right } : null,
      textarea: textareaRect ? {
        left: textareaRect.left,
        right: textareaRect.right,
        top: textareaRect.top,
        bottom: textareaRect.bottom,
      } : null,
    };
  });
  if (
    !fit.section
    || !fit.textarea
    || fit.page.width > fit.page.clientWidth + 1
    || fit.section.left < 0
    || fit.section.right > fit.viewport.width + 1
    || fit.textarea.left < 0
    || fit.textarea.right > fit.viewport.width + 1
  ) {
    throw new Error(`HR draft card does not fit the reduced window: ${JSON.stringify(fit)}`);
  }
  const hrScreenshot = path.join(outputDir, 'hr-drafts-installed-dev.png');
  await main.screenshot({ path: hrScreenshot });

  console.log(JSON.stringify({
    ok: true,
    calendar: {
      pageScrollDelta: afterWheel[0] - beforeWheel[0],
      gridVerticalScrollDelta: afterWheel[1] - beforeWheel[1],
    },
    hr: {
      pending: beforeDrafts.pendingIds.length,
      suggestionsReady: afterDrafts.suggestionsReady,
      sentCounterUnchanged: true,
      replyHistoryUnchanged: true,
      editSurvivedRefresh: true,
    },
    reducedWindow: fit.viewport,
    screenshots: [calendarScreenshot, hrScreenshot],
  }, null, 2));
} finally {
  if (main && !main.isClosed()) {
    await main.evaluate(async (enabled) => {
      await window.electronAPI?.hhChat?.setEnabled(enabled);
    }, originalChatEnabled).catch(() => undefined);
  }
  await app.close().catch(() => undefined);
}
