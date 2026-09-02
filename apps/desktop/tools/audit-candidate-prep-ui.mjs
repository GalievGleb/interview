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

const outputDir = path.resolve(process.cwd(), '..', '..', 'output', 'playwright', 'candidate-prep-audit');
fs.mkdirSync(outputDir, { recursive: true });

const app = await electron.launch({ executablePath, timeout: 30_000 });

async function mainWindow() {
  const current = app.windows().find((page) => !page.url().includes('#/overlay'));
  if (current) return current;
  return app.waitForEvent('window', {
    predicate: (page) => !page.url().includes('#/overlay'),
    timeout: 10_000,
  });
}

const routes = [
  { id: 'documents', hash: '#/documents', title: 'Резюме и опыт' },
  { id: 'prepare', hash: '#/prepare', title: 'Поймите, что вас спросят до интервью.' },
  { id: 'practice', hash: '#/practice', title: 'Тренировка ответов' },
  { id: 'practice-new', hash: '#/practice/new', title: 'Практика по роли' },
];

try {
  const page = await mainWindow();
  await page.waitForLoadState('domcontentloaded');
  const results = [];

  for (const theme of ['light', 'dark']) {
    for (const route of routes) {
      await page.evaluate(({ hash, themeName }) => {
        document.documentElement.dataset.theme = themeName;
        window.location.hash = hash;
      }, { hash: route.hash, themeName: theme });
      await page.waitForFunction(
        (expectedTitle) => document.querySelector('h1')?.textContent?.trim() === expectedTitle,
        route.title,
        { timeout: 10_000 },
      );
      const settled = await page.waitForFunction(
        () => !/(?:Загрузка|Загружается|Загружаю|Загружаем|Проверяем сохранённый контекст)/i.test(document.body.innerText),
        undefined,
        { timeout: 8_000 },
      ).then(() => true).catch(() => false);
      await page.waitForTimeout(250);

      const state = await page.evaluate(() => {
        const prep = document.querySelector('.prep');
        const wrap = document.querySelector('.prep-wrap');
        const interactive = Array.from(document.querySelectorAll('button, a, input, textarea, select'));
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const overflow = interactive
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              text: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 80),
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
            };
          })
          .filter((rect) => rect.right > viewport.width + 1 || rect.left < -1);
        return {
          title: document.querySelector('h1')?.textContent?.trim() ?? '',
          text: document.body.innerText.slice(0, 6_000),
          viewport,
          pageScrollWidth: document.documentElement.scrollWidth,
          prepScrollWidth: prep?.scrollWidth ?? null,
          prepClientWidth: prep?.clientWidth ?? null,
          wrapTop: wrap ? Math.round(wrap.getBoundingClientRect().top) : null,
          overflow,
        };
      });

      const screenshot = path.join(outputDir, `${route.id}-${theme}.png`);
      await page.screenshot({ path: screenshot });
      results.push({ route: route.id, theme, screenshot, settled, ...state });
    }
  }

  fs.writeFileSync(path.join(outputDir, 'audit.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ text: _text, ...result }) => result), null, 2));
} finally {
  await app.close().catch(() => undefined);
}
