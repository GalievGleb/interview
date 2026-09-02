import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import {
  failWhenChildExits,
  waitForOwnedVite,
} from './source-ui-vite-guard.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(toolsDir, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const outputDir = path.join(
  repoRoot,
  'output',
  'verification',
  'real-interview-overlay',
);
const pnpmExecutable = process.env.npm_execpath ? process.execPath : 'pnpm';
const pnpmPrefix = process.env.npm_execpath ? [process.env.npm_execpath] : [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(' ')}):\n${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startApiHealthStub(port) {
  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"status":"ok"}');
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"detail":"visual fixture"}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function stopServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function waitForElectronWindow(app, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = app.windows().find(predicate);
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const urls = app.windows().map((page) => page.url());
  throw new Error(`Electron renderer did not appear. Open URLs: ${JSON.stringify(urls)}`);
}

function stopProcessTree(child) {
  if (!child?.pid || child.exitCode != null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    child.kill('SIGTERM');
  }
}

function sse(...events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const completeAnswer = [
  'Сначала сохраню сигнатуру функции и выполню один параметризованный запрос по идентификатору.',
  '',
  '```python',
  'def get_order(conn, order_id: int) -> list[dict[str, Any]]:',
  '# Сохраняем сигнатуру из условия.',
  '    rows = conn.execute(\'SELECT * FROM "Order" WHERE id = ?\', (order_id,))',
  '    # Передаём идентификатор параметром, а не склеиваем SQL.',
  '    return [dict(row) for row in rows]',
  '    # Возвращаем строки в заявленном формате.',
  `    marker = "${'very_long_token_'.repeat(35)}"`,
  '    # Проверяем перенос длинного непрерывного значения.',
  '```',
].join('\n');

const partialAnswer = [
  'Короткий план.',
  '',
  '```sql',
  'SELECT * FROM "Order"',
  '-- Выбираем заказы.',
].join('\n');

console.log('[source-ui] compiling Electron main/preload');
run(pnpmExecutable, [...pnpmPrefix, 'exec', 'tsc', '-p', 'tsconfig.electron.json']);

const apiPort = await freePort();
const vitePort = 5173;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const sourceUiNonce = randomUUID();
const nonceFileName = `source-ui-nonce-${sourceUiNonce}.mjs`;
const nonceFilePath = path.join(toolsDir, nonceFileName);
fs.writeFileSync(
  nonceFilePath,
  'export default import.meta.env.VITE_SOURCE_UI_NONCE;\n',
  'utf8',
);
const temporaryUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-source-ui-'));
const temporaryLocalAppData = path.join(temporaryUserData, 'local-app-data');
fs.mkdirSync(temporaryLocalAppData, { recursive: true });
const sourceEnv = {
  ...process.env,
  API_URL: apiUrl,
  VITE_API_URL: apiUrl,
  SKILLCUE_API_DIR: path.join(repoRoot, 'apps', 'api-py'),
  SKILLCUE_PYTHON: path.join(repoRoot, 'apps', 'api-py', '.venv', 'Scripts', 'python.exe'),
  SKILLCUE_BUILD_CHANNEL: 'dev',
  VITE_SOURCE_UI_NONCE: sourceUiNonce,
  APPDATA: temporaryUserData,
  LOCALAPPDATA: temporaryLocalAppData,
  ELECTRON_ENABLE_LOGGING: '1',
};
const bootstrapPath = path.join(temporaryUserData, 'source-ui-bootstrap.cjs');
fs.writeFileSync(
  bootstrapPath,
  [
    "const electron = require('electron');",
    'electron.app.requestSingleInstanceLock = () => true;',
    'electron.app.setAsDefaultProtocolClient = () => true;',
    `const sourceUiCaptureFixture = electron.nativeImage.createFromPath(${JSON.stringify(path.join(desktopRoot, 'assets', 'branding', 'skillcue-app-icon-512.png'))}).resize({ width: 64 }).toDataURL();`,
    'const sourceUiIpcHandle = electron.ipcMain.handle.bind(electron.ipcMain);',
    "electron.ipcMain.handle = (channel, listener) => sourceUiIpcHandle(channel, channel === 'overlay:captureScreen' ? async () => sourceUiCaptureFixture : listener);",
    `require(${JSON.stringify(path.join(desktopRoot, 'dist-electron', 'main.js'))});`,
  ].join('\n'),
  'utf8',
);
const vite = spawn(
  pnpmExecutable,
  [...pnpmPrefix, 'exec', 'vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
  { cwd: desktopRoot, env: sourceEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);
const viteExitGuard = failWhenChildExits(vite);
let app;
let apiHealthStub;

try {
  await Promise.race([
    (async () => {
  console.log(`[source-ui] starting isolated API health stub on ${apiPort}`);
  apiHealthStub = await startApiHealthStub(apiPort);
  console.log(`[source-ui] waiting for owned Vite identity on ${vitePort}`);
  await waitForOwnedVite({
    child: vite,
    probeUrl: `http://127.0.0.1:${vitePort}/tools/${nonceFileName}`,
    expectedNonce: sourceUiNonce,
  });
  console.log('[source-ui] launching workspace Electron');
  app = await electron.launch({
    args: [bootstrapPath, `--user-data-dir=${temporaryUserData}`],
    cwd: desktopRoot,
    env: sourceEnv,
    timeout: 30_000,
    executablePath: path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
  });
  console.log('[source-ui] Electron connected');
  let requestIndex = 0;
  const chatRequestPaths = [];
  app.context().on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/chat/')) chatRequestPaths.push(url.pathname);
  });
  // An explicit visual instruction submitted through the real input routes to
  // screen SSE. Intercept this one endpoint only; every other request still
  // exercises normal source renderer/preload behavior.
  await app.context().route('**/chat/screen/stream', async (route) => {
    requestIndex += 1;
    console.log(`[source-ui] intercepted screen request #${requestIndex}`);
    const body = requestIndex === 1
      ? sse(
        { type: 'chunk', text: completeAnswer },
        { type: 'done', model: 'sanitized-fixture', model_source: 'visual-gate' },
      )
      : sse(
        { type: 'chunk', text: partialAnswer },
        { type: 'error', message: 'Ответ оборвался из-за лимита модели. Повторите запрос.' },
      );
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      body,
    });
  });

  const isMainRenderer = (page) => (
    page.url().startsWith(`http://localhost:${vitePort}/`)
    && !page.url().includes('#/overlay')
  );
  const main = await waitForElectronWindow(app, isMainRenderer);
  main.on('pageerror', (error) => console.error(`[source-ui] renderer error: ${error.message}`));
  const preloadReady = await main.evaluate(() => Boolean(window.electronAPI?.overlay?.show));
  console.log(`[source-ui] preload overlay API ready: ${preloadReady}`);
  if (!preloadReady) {
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => ({
      url: win.webContents.getURL(),
      bounds: win.getBounds(),
    })));
    throw new Error(`Workspace preload did not expose overlay API: ${JSON.stringify(windows)}`);
  }
  await main.waitForLoadState('domcontentloaded');
  await main.evaluate(() => { window.location.hash = '#/'; });
  const openButton = main.getByRole('button', { name: 'Открыть помощника' }).first();
  await openButton.waitFor({ state: 'visible', timeout: 20_000 });
  await openButton.click();
  const overlay = await waitForElectronWindow(
    app,
    (page) => page.url().includes('#/overlay'),
  );
  await overlay.waitForLoadState('domcontentloaded');
  overlay.on('pageerror', (error) => console.error(`[source-ui] overlay renderer error: ${error.message}`));
  overlay.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.error(`[source-ui] overlay console ${message.type()}: ${message.text()}`);
    }
  });
  await overlay.evaluate(() => {
    window.addEventListener('unhandledrejection', (event) => {
      console.error(`unhandled rejection: ${String(event.reason?.stack ?? event.reason)}`);
    });
  });
  const overlayCaptureReady = await overlay.evaluate(
    () => Boolean(window.electronAPI?.overlay?.captureScreen),
  );
  console.log(`[source-ui] overlay capture API ready: ${overlayCaptureReady}`);
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('#/overlay'));
    if (!win) throw new Error('Overlay BrowserWindow not found');
    win.setBounds({ width: 680, height: 780 });
  });
  await overlay.locator('.ovl-input').waitFor({ state: 'visible', timeout: 15_000 });
  const dismissGuide = overlay.locator('.ovl-quick-guide__done');
  try {
    await dismissGuide.waitFor({ state: 'visible', timeout: 2_000 });
    await dismissGuide.click();
    await overlay.locator('.ovl-quick-guide').waitFor({ state: 'detached', timeout: 2_000 });
  } catch (error) {
    if (await dismissGuide.isVisible().catch(() => false)) throw error;
  }

  await overlay.locator('.ovl-input').fill('Реши код на экране и покажи полный актуальный вариант.');
  const sendButton = overlay.getByRole('button', { name: 'Отправить' });
  await sendButton.hover();
  await overlay.waitForTimeout(250);
  await sendButton.click();
  try {
    await overlay.locator('.ovl-answer-body pre').waitFor({ state: 'visible', timeout: 12_000 });
  } catch (error) {
    const failureState = await overlay.evaluate(() => {
      const notice = document.querySelector('.ovl-notice');
      const answer = document.querySelector('.ovl-answer-body');
      const response = document.querySelector('.ovl-response');
      return {
        documentVisible: document.visibilityState,
        responseExists: Boolean(response),
        responseClass: response?.className ?? null,
        answerExists: Boolean(answer),
        answerClass: answer?.className ?? null,
        answerText: answer?.textContent?.trim().slice(0, 240) ?? null,
        noticeExists: Boolean(notice),
        noticeClass: notice?.className ?? null,
        noticeText: notice?.textContent?.trim().slice(0, 240) ?? null,
        viewedScreenVisible: Boolean(document.querySelector('.ovl-viewed')),
        thinkingVisible: Boolean(document.querySelector('.ovl-think-dot')),
        inputValue: document.querySelector('.ovl-input')?.value ?? null,
        sendDisabled: document.querySelector('.ovl-send')?.disabled ?? null,
        bodyTail: document.body.innerText.trim().slice(-800),
      };
    });
    const windowState = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('#/overlay'));
      return win ? { visible: win.isVisible(), destroyed: win.isDestroyed() } : null;
    });
    console.error(`[source-ui] screen request diagnostics: ${JSON.stringify({
      overlayCaptureReady,
      requestIndex,
      chatRequestPaths,
      windowState,
      failureState,
    })}`);
    throw error;
  }

  const inspectLayout = async (background) => {
    await overlay.evaluate((color) => {
      document.documentElement.style.background = color;
      document.body.style.background = color;
    }, background);
    return overlay.evaluate(() => {
      const response = document.querySelector('.ovl-response');
      const body = document.querySelector('.ovl-answer-body');
      const pre = body?.querySelector('pre');
      const codeShell = pre?.parentElement;
      const stack = document.querySelector('.ovl-stack');
      const responseRect = response?.getBoundingClientRect();
      const bodyRect = body?.getBoundingClientRect();
      const preRect = pre?.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        responseOverflow: response ? response.scrollWidth - response.clientWidth : null,
        answerOverflow: body ? body.scrollWidth - body.clientWidth : null,
        preWithinAnswer: Boolean(
          bodyRect && preRect && preRect.left >= bodyRect.left - 1 && preRect.right <= bodyRect.right + 1
        ),
        responseWithinViewport: Boolean(
          responseRect && responseRect.left >= -1 && responseRect.right <= innerWidth + 1
        ),
        verticalContainer: stack ? getComputedStyle(stack).overflowY : null,
        codeVisualTreatment: Boolean(codeShell && (() => {
          const style = getComputedStyle(codeShell);
          return (
            style.backgroundColor !== 'rgba(0, 0, 0, 0)'
            && Number.parseFloat(style.borderTopWidth) > 0
          );
        })()),
      };
    });
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const dark = await inspectLayout('#0b1020');
  await overlay.screenshot({ path: path.join(outputDir, 'overlay-dark.png') });
  const light = await inspectLayout('#f6f4ef');
  await overlay.screenshot({ path: path.join(outputDir, 'overlay-light.png') });

  for (const [name, state] of Object.entries({ dark, light })) {
    const failed = (
      state.documentWidth > state.viewportWidth
      || state.responseOverflow > 1
      || state.answerOverflow > 1
      || !state.preWithinAnswer
      || !state.responseWithinViewport
      || state.verticalContainer !== 'auto'
      || !state.codeVisualTreatment
    );
    if (failed) throw new Error(`${name} overlay layout failed: ${JSON.stringify(state)}`);
  }

  await overlay.locator('.ovl-input').fill('Повтори решение задачи на экране для проверки обрыва.');
  await sendButton.hover();
  await overlay.waitForTimeout(250);
  await sendButton.click();
  const warning = overlay.locator('.ovl-answer-issue');
  await warning.waitFor({ state: 'visible', timeout: 12_000 });
  const truncation = await overlay.evaluate((expectedPartial) => {
    const issue = document.querySelector('.ovl-answer-issue');
    const pre = document.querySelector('.ovl-answer-body pre');
    const bodyText = document.querySelector('.ovl-answer-body')?.textContent ?? '';
    return {
      warningOutsideCode: Boolean(issue && pre && !pre.contains(issue)),
      warningTextOutsideAnswer: Boolean(issue && !document.querySelector('.ovl-answer-body')?.contains(issue)),
      partialTextPreserved: bodyText.includes('SELECT * FROM "Order"'),
      syntheticFenceVisible: bodyText.includes('```'),
      originalLength: expectedPartial.length,
    };
  }, partialAnswer);
  if (
    !truncation.warningOutsideCode
    || !truncation.warningTextOutsideAnswer
    || !truncation.partialTextPreserved
    || truncation.syntheticFenceVisible
  ) {
    throw new Error(`Truncated answer layout failed: ${JSON.stringify(truncation)}`);
  }
  await overlay.screenshot({ path: path.join(outputDir, 'overlay-truncated.png') });

  const report = {
    schemaVersion: 1,
    sourceTree: true,
    viewport: { width: 680, height: 780 },
    dark,
    light,
    truncation,
    screenshots: ['overlay-dark.png', 'overlay-light.png', 'overlay-truncated.png'],
  };
  fs.writeFileSync(
    path.join(outputDir, 'overlay-layout.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(`OK source overlay UI: ${path.join(outputDir, 'overlay-layout.json')}`);
    })(),
    viteExitGuard.failure,
  ]);
} finally {
  viteExitGuard.dispose();
  if (app) await app.close().catch(() => undefined);
  await stopServer(apiHealthStub);
  stopProcessTree(vite);
  fs.rmSync(nonceFilePath, { force: true });
  if (temporaryUserData.startsWith(os.tmpdir())) {
    fs.rmSync(temporaryUserData, { recursive: true, force: true });
  }
}
