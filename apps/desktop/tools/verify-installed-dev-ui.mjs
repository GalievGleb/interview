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

if (!fs.existsSync(executablePath)) {
  throw new Error(`Installed SkillCue Dev executable was not found: ${executablePath}`);
}

const app = await electron.launch({ executablePath, timeout: 30_000 });

async function overlayWindow() {
  const existing = app.windows().find((page) => page.url().includes('#/overlay'));
  if (existing) return existing;
  return app.waitForEvent('window', {
    predicate: (page) => page.url().includes('#/overlay'),
    timeout: 10_000,
  });
}

async function mainWindow() {
  const existing = app.windows().find((page) => !page.url().includes('#/overlay'));
  if (existing) return existing;
  return app.waitForEvent('window', {
    predicate: (page) => !page.url().includes('#/overlay'),
    timeout: 10_000,
  });
}

try {
  const main = await mainWindow();
  await main.waitForLoadState('domcontentloaded');
  await main.evaluate(() => {
    window.location.hash = '#/';
  });
  await main.getByRole('heading', { name: 'Главная SkillCue' }).waitFor({ timeout: 20_000 });

  const attentionAction = main.locator('.home-command-attention__list button').first();
  await attentionAction.waitFor({ state: 'visible', timeout: 12_000 });
  const originalTheme = await main.evaluate(() => document.documentElement.dataset.theme);
  await main.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await attentionAction.hover();
  const homeVisualState = await main.evaluate(() => {
    const prep = document.querySelector('.prep');
    const commandCenter = document.querySelector('.home-command-center');
    const hoveredAction = document.querySelector('.home-command-attention__list button:hover');
    const actionTitle = hoveredAction?.querySelector('strong');
    const actionDetail = hoveredAction?.querySelector('small');

    const parseRgb = (value) => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      return channels?.length === 3 ? channels : null;
    };
    const relativeLuminance = (value) => {
      const rgb = parseRgb(value);
      if (!rgb) return null;
      const linear = rgb.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const contrast = (foreground, background) => {
      const foregroundLuminance = relativeLuminance(foreground);
      const backgroundLuminance = relativeLuminance(background);
      if (foregroundLuminance == null || backgroundLuminance == null) return null;
      const lighter = Math.max(foregroundLuminance, backgroundLuminance);
      const darker = Math.min(foregroundLuminance, backgroundLuminance);
      return (lighter + 0.05) / (darker + 0.05);
    };

    const prepRect = prep?.getBoundingClientRect();
    const commandRect = commandCenter?.getBoundingClientRect();
    const hoverBackground = hoveredAction ? getComputedStyle(hoveredAction).backgroundColor : '';
    const titleColor = actionTitle ? getComputedStyle(actionTitle).color : '';
    const detailColor = actionDetail ? getComputedStyle(actionDetail).color : '';
    return {
      commandTopGap: prepRect && commandRect ? commandRect.top - prepRect.top : null,
      hoverBackground,
      titleContrast: contrast(titleColor, hoverBackground),
      detailContrast: contrast(detailColor, hoverBackground),
    };
  });
  await main.evaluate((theme) => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, originalTheme);
  const visualFailures = [];
  if (homeVisualState.commandTopGap == null || homeVisualState.commandTopGap > 40) {
    visualFailures.push(`dashboard top gap is ${homeVisualState.commandTopGap}px (expected <= 40px)`);
  }
  if (homeVisualState.titleContrast == null || homeVisualState.titleContrast < 4.5) {
    visualFailures.push(`hover title contrast is ${homeVisualState.titleContrast?.toFixed(2) ?? 'unknown'}:1`);
  }
  if (homeVisualState.detailContrast == null || homeVisualState.detailContrast < 4.5) {
    visualFailures.push(`hover detail contrast is ${homeVisualState.detailContrast?.toFixed(2) ?? 'unknown'}:1`);
  }
  if (visualFailures.length > 0) {
    throw new Error(`Home visual regression: ${visualFailures.join('; ')}. State: ${JSON.stringify(homeVisualState)}`);
  }

  const scrollState = await main.evaluate(() => ({
    viewport: window.innerHeight,
    document: document.documentElement.scrollHeight,
    body: document.body.scrollHeight,
    bodyOverflow: getComputedStyle(document.body).overflowY,
  }));
  if (scrollState.document > scrollState.viewport + 1 || scrollState.body > scrollState.viewport + 1) {
    throw new Error(`Home page scrolls: ${JSON.stringify(scrollState)}`);
  }

  const opening = overlayWindow();
  await main.getByRole('button', { name: 'Открыть помощника' }).first().click();
  const overlay = await opening;
  await overlay.waitForLoadState('domcontentloaded');

  const record = overlay.locator('.ovl-rec');
  await record.waitFor({ state: 'visible', timeout: 15_000 });
  await record.evaluate((button) => {
    if (button.disabled) throw new Error(`Record button is disabled: ${button.getAttribute('aria-label')}`);
  });
  await record.click();
  await overlay.getByRole('button', { name: 'Завершить созвон и запись' }).waitFor({
    state: 'visible',
    timeout: 12_000,
  });
  if (!(await record.getAttribute('class'))?.includes('ovl-rec--live')) {
    throw new Error('Record button did not enter the live state.');
  }

  const menuButton = overlay.getByRole('button', { name: 'Меню' });
  await menuButton.click();
  const menu = overlay.locator('.ovl-main-menu');
  await menu.waitFor({ state: 'visible', timeout: 3_000 });
  await overlay.mouse.click(8, 8);
  await menu.waitFor({ state: 'detached', timeout: 3_000 });

  await overlay.getByRole('button', { name: 'Завершить созвон и запись' }).click();
  await overlay.getByRole('button', { name: 'Начать запись' }).waitFor({
    state: 'visible',
    timeout: 12_000,
  });

  await main.getByRole('link', { name: 'Интервью' }).click();
  await main.waitForTimeout(1_500);
  const historyText = await main.locator('body').innerText();
  if (/не\s*авторизован|unauthoriz/iu.test(historyText)) {
    throw new Error('Dev interview history rendered an unauthorized state.');
  }
  const firstHistoryRow = main.locator('.interview-session-row').first();
  await firstHistoryRow.waitFor({ state: 'visible', timeout: 12_000 });
  const historyRowState = await firstHistoryRow.evaluate((row) => {
    const metadata = row.querySelector('small')?.textContent?.trim() ?? '';
    const removeButton = row.querySelector('button[aria-label^="Удалить интервью"]');
    const rowRect = row.getBoundingClientRect();
    const removeRect = removeButton?.getBoundingClientRect();
    return {
      metadata,
      rightInset: removeRect ? rowRect.right - removeRect.right : null,
    };
  });
  if (!/^(?:Пн|Вт|Ср|Чт|Пт|Сб|Вс), \d{2}\.\d{2}\.\d{2} · (?:\d{2}:\d{2}–\d{2}:\d{2}|с \d{2}:\d{2}) · \d+ ответ/iu.test(historyRowState.metadata)) {
    throw new Error(`History time range is unclear: ${JSON.stringify(historyRowState)}`);
  }
  if (historyRowState.rightInset == null || historyRowState.rightInset < 10) {
    throw new Error(`History delete action is too close to the edge: ${JSON.stringify(historyRowState)}`);
  }
  const historyScreenshot = path.resolve(
    process.cwd(),
    '..',
    '..',
    'output',
    'playwright',
    'history-installed-dev.png',
  );
  fs.mkdirSync(path.dirname(historyScreenshot), { recursive: true });
  await main.screenshot({ path: historyScreenshot });

  await firstHistoryRow.getByRole('button', { name: 'Отправить отчёт' }).click();
  const reportDialog = main.getByRole('dialog', { name: 'Отправить отчёт по сессии' });
  await reportDialog.waitFor({ state: 'visible', timeout: 5_000 });
  const reportOpenButton = reportDialog.getByRole('button', { name: 'Открыть файл' });
  const reportTelegramButton = reportDialog.getByRole('button', { name: 'Прикрепить в Telegram' });
  if (await reportDialog.locator('input[type="checkbox"]').count()) {
    throw new Error('Session report still requires the removed consent checkbox.');
  }
  if (await reportOpenButton.isDisabled()) {
    throw new Error('Local session report cannot be opened before entering a Telegram message.');
  }
  if (!(await reportTelegramButton.isDisabled())) {
    throw new Error('Telegram report action must wait for a problem description.');
  }
  await app.evaluate(({ shell }) => {
    globalThis.__skillCueOriginalOpenPath = shell.openPath;
    globalThis.__skillCueOpenedReportPath = '';
    shell.openPath = async (target) => {
      globalThis.__skillCueOpenedReportPath = target;
      return '';
    };
  });
  await reportOpenButton.click();
  await reportDialog.getByText('Отчёт открыт.', { exact: true }).waitFor({ timeout: 12_000 });
  const renderedReportPath = (await reportDialog.locator('code').textContent())?.trim() ?? '';
  const openedReportPath = await app.evaluate(() => globalThis.__skillCueOpenedReportPath ?? '');
  if (!renderedReportPath || renderedReportPath !== openedReportPath || !fs.existsSync(renderedReportPath)) {
    throw new Error(`Local session report did not open the saved file: ${JSON.stringify({ renderedReportPath, openedReportPath })}`);
  }
  const reportLayout = await reportDialog.evaluate((dialog) => {
    const dialogRect = dialog.getBoundingClientRect();
    const buttons = Array.from(dialog.querySelectorAll('button')).map((button) => {
      const rect = button.getBoundingClientRect();
      return { text: button.textContent?.trim() ?? '', left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    return {
      dialog: { left: dialogRect.left, right: dialogRect.right, top: dialogRect.top, bottom: dialogRect.bottom },
      buttons,
    };
  });
  if (reportLayout.buttons.some((button) => (
    button.left < reportLayout.dialog.left
    || button.right > reportLayout.dialog.right
    || button.top < reportLayout.dialog.top
    || button.bottom > reportLayout.dialog.bottom
  ))) {
    throw new Error(`Session report actions overflow the dialog: ${JSON.stringify(reportLayout)}`);
  }
  const reportScreenshot = path.resolve(
    process.cwd(),
    '..',
    '..',
    'output',
    'playwright',
    'session-report-installed-dev.png',
  );
  await main.screenshot({ path: reportScreenshot });
  await app.evaluate(({ shell }) => {
    if (globalThis.__skillCueOriginalOpenPath) {
      shell.openPath = globalThis.__skillCueOriginalOpenPath;
    }
    delete globalThis.__skillCueOriginalOpenPath;
    delete globalThis.__skillCueOpenedReportPath;
  });
  await reportDialog.getByRole('button', { name: 'Закрыть' }).last().click();

  await main.getByRole('link', { name: 'Настройки' }).click();
  await main.getByRole('button', { name: 'Подписка' }).click();
  await main.getByText('Max — всё включено', { exact: true }).waitFor({ timeout: 12_000 });

  console.log(
    `OK installed dev UI: home=${scrollState.document}x${scrollState.viewport} `
    + `home-top-gap=${homeVisualState.commandTopGap}px hover-contrast=${homeVisualState.titleContrast?.toFixed(2)}/${homeVisualState.detailContrast?.toFixed(2)} `
    + `overlay-open=true record-live=true menu-outside-click=true history-auth=true history-right-inset=${historyRowState.rightInset}px `
    + `report-local-open=true report-checkbox=false report-telegram-gated=true plan=max `
    + `screenshots=${historyScreenshot},${reportScreenshot}`,
  );
} finally {
  await app.close().catch(() => undefined);
}
