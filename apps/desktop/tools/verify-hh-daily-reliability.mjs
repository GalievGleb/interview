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
const statePath = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'SkillCue Dev',
  'hh-browser-assistant.json',
);

if (!fs.existsSync(executablePath)) {
  throw new Error(`Installed SkillCue Dev executable was not found: ${executablePath}`);
}

async function launchInstalledDev() {
  const app = await electron.launch({ executablePath, timeout: 30_000 });
  const main = app.windows().find((page) => !page.url().includes('#/overlay'))
    ?? await app.waitForEvent('window', {
      predicate: (page) => !page.url().includes('#/overlay'),
      timeout: 15_000,
    });
  await main.waitForLoadState('domcontentloaded');
  return { app, main };
}

async function hhApi(main) {
  await main.waitForFunction(() => Boolean(window.electronAPI?.hhAssistant), null, {
    timeout: 15_000,
  });
  return {
    getState: () => main.evaluate(() => window.electronAPI.hhAssistant.getState()),
    getResumes: () => main.evaluate(() => window.electronAPI.hhAssistant.getResumes()),
    saveConfig: (config) => main.evaluate(
      (nextConfig) => window.electronAPI.hhAssistant.saveConfig(nextConfig),
      config,
    ),
    scan: () => main.evaluate(() => window.electronAPI.hhAssistant.scan('hh')),
  };
}

function sentFingerprint(state) {
  const sent = state.queue.filter((item) => item.status === 'sent');
  return {
    count: sent.length,
    latest: sent.map((item) => item.sentAt ?? '').sort().at(-1) ?? '',
  };
}

function qaAutomationPythonResumes(resumes) {
  return resumes.filter((resume) => (
    /qa\s+automation\s+engineer/iu.test(resume.title)
    && /python/iu.test(resume.title)
  ));
}

let firstApp;
let secondApp;
let firstMain;
let secondMain;
let originalConfig;
try {
  ({ app: firstApp, main: firstMain } = await launchInstalledDev());
  const first = await hhApi(firstMain);
  const initial = await first.getState();
  originalConfig = initial.config;
  // Cancel restored timers before any potentially slow HH résumé request.
  await first.saveConfig({
    ...initial.config,
    autoSend: false,
    autoRunDaily: false,
  });
  const resumes = await first.getResumes();
  const matches = qaAutomationPythonResumes(resumes);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one QA Automation Engineer Python résumé, found ${matches.length}. `
      + 'The saved selection was not changed.',
    );
  }
  const selectedResumeTitle = matches[0].title;

  await first.saveConfig({
    ...initial.config,
    autoSend: false,
    autoRunDaily: true,
    // Keep the regression check away from the immediate discovery window.
    autoRunHour: 23,
    resumeTitles: [selectedResumeTitle],
    resumeTitleContains: '',
    resumeSelectionExplicitlyConfirmed: true,
  });
  await firstApp.close();
  firstApp = undefined;

  ({ app: secondApp, main: secondMain } = await launchInstalledDev());
  const second = await hhApi(secondMain);
  await secondMain.evaluate(() => { window.location.hash = '#/applications'; });
  await secondMain.waitForTimeout(4_000);

  const afterLicenceLoad = await second.getState();
  if (!afterLicenceLoad.config.autoRunDaily) {
    throw new Error('Daily HH schedule was disabled again while the licence was loading.');
  }
  if (!afterLicenceLoad.nextRunAt) {
    throw new Error('Daily HH discovery timer was not restored after restart.');
  }
  if (afterLicenceLoad.config.autoSend) {
    throw new Error('Dry-run guard was lost: autoSend became enabled before discovery.');
  }
  if (afterLicenceLoad.config.resumeTitles.length !== 1) {
    throw new Error('The explicit HH résumé selection did not persist across restart.');
  }

  await second.saveConfig({
    ...afterLicenceLoad.config,
    autoSend: false,
    autoRunDaily: false,
    autoRunHour: originalConfig.autoRunHour,
  });
  const beforeScan = await second.getState();
  const sentBefore = sentFingerprint(beforeScan);
  const knownBefore = new Set(beforeScan.queue.map((item) => item.key));

  const afterScan = await second.scan();
  const sentAfter = sentFingerprint(afterScan);
  if (afterScan.phase !== 'ready' || afterScan.loginRequired) {
    throw new Error(`Read-only HH discovery did not finish: phase=${afterScan.phase}; ${afterScan.message}`);
  }
  if (!afterScan.lastScanSummary || afterScan.lastScanSummary.pagesScanned < 1) {
    throw new Error('Read-only HH discovery returned no scan summary.');
  }
  if (sentAfter.count !== sentBefore.count || sentAfter.latest !== sentBefore.latest) {
    throw new Error('Dry-run discovery changed the sent-applications fingerprint.');
  }
  const ungatedUnreadable = afterScan.queue.filter((item) => (
    item.reason === 'Не удалось распознать состояние страницы HH.'
    && item.autoRetryBlockedUntil !== 'daily'
  ));
  if (ungatedUnreadable.length > 0) {
    throw new Error(`${ungatedUnreadable.length} unreadable HH queue item(s) still have a short retry gate.`);
  }

  const newQueueItems = afterScan.queue.filter((item) => !knownBefore.has(item.key)).length;
  await second.saveConfig({
    ...afterScan.config,
    autoSend: true,
    autoRunDaily: true,
    autoRunHour: originalConfig.autoRunHour,
    resumeTitles: afterLicenceLoad.config.resumeTitles,
    resumeTitleContains: '',
    resumeSelectionExplicitlyConfirmed: true,
  });
  await secondApp.close();
  secondApp = undefined;

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const persistedUngatedUnreadable = persisted.queue.filter((item) => (
    item.reason === 'Не удалось распознать состояние страницы HH.'
    && item.autoRetryBlockedUntil !== 'daily'
  ));
  if (!persisted.config.autoRunDaily || !persisted.config.autoSend) {
    throw new Error('Final HH daily automatic mode was not persisted.');
  }
  if (persisted.config.resumeTitles.length !== 1 || persisted.resumeSelectionConfirmed !== true) {
    throw new Error('Final explicit HH résumé selection was not persisted.');
  }
  if (persistedUngatedUnreadable.length > 0) {
    throw new Error('The persisted HH queue still contains an ungated unreadable vacancy.');
  }

  console.log(JSON.stringify({
    ok: true,
    licenceRacePreservedDailySchedule: true,
    dryRunSentUnchanged: true,
    scan: {
      queries: afterScan.lastScanSummary.queries.length,
      pagesScanned: afterScan.lastScanSummary.pagesScanned,
      found: afterScan.lastScanSummary.found,
      newVacancies: afterScan.lastScanSummary.newVacancies,
      newQueueItems,
      excluded: afterScan.lastScanSummary.excluded,
    },
    final: {
      autoRunDaily: persisted.config.autoRunDaily,
      autoSend: persisted.config.autoSend,
      selectedResumeCount: persisted.config.resumeTitles.length,
      ungatedUnreadable: persistedUngatedUnreadable.length,
    },
  }, null, 2));
} finally {
  await secondApp?.close().catch(() => undefined);
  await firstApp?.close().catch(() => undefined);
}
