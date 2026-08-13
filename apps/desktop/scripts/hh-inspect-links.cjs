const path = require('node:path');

const { HhBrowserAssistant } = require('../dist-electron/hhBrowserAssistant.js');

async function main() {
  const ids = process.argv.slice(2);
  const assistant = new HhBrowserAssistant(
    path.join(process.env.APPDATA, 'SkillCue Dev'),
    () => undefined,
  );
  try {
    const page = await assistant.ensureBrowser('background');
    const results = [];
    for (const id of ids) {
      const url = `https://hh.ru/vacancy/${id}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const read = async (selector) => page.locator(selector).first().innerText({ timeout: 5_000 }).catch(() => '');
      results.push({
        id,
        finalUrl: page.url(),
        title: await read('[data-qa="vacancy-title"], h1'),
        company: await read('[data-qa="vacancy-company-name"], [data-qa="vacancy-company-name"] a'),
        description: (await read('[data-qa="vacancy-description"]')).replace(/\s+/g, ' ').trim(),
        pageText: (await read('body')).replace(/\s+/g, ' ').trim().slice(0, 2_000),
        formatDataQa: await page.locator('[data-qa]').evaluateAll((nodes) => nodes
          .map((node) => ({ qa: node.getAttribute('data-qa'), text: node.textContent?.replace(/\s+/g, ' ').trim() }))
          .filter((item) => item.text && /формат работы|удал[её]н|гибрид|на месте работодателя/i.test(item.text))
          .slice(0, 20)),
      });
    }
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    await assistant.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
