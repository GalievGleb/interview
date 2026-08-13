const path = require('node:path');

const { HhBrowserAssistant } = require('../dist-electron/hhBrowserAssistant.js');

async function main() {
  const vacancyId = process.argv[2];
  if (!vacancyId) throw new Error('Usage: node scripts/hh-verify-application.cjs <vacancy-id>');
  process.stderr.write(`Verifying HH vacancy ${vacancyId}...\n`);

  const assistant = new HhBrowserAssistant(
    path.join(process.env.APPDATA, 'SkillCue Dev'),
    () => undefined,
  );
  try {
    const vacancy = assistant.state.queue.find(
      (item) => item.id === vacancyId || item.key === vacancyId,
    );
    if (!vacancy) throw new Error(`Vacancy ${vacancyId} is missing from the queue`);
    process.stderr.write(`Queue item: ${vacancy.title} · ${vacancy.company}\n`);
    const page = await assistant.ensureBrowser('background');
    const result = await assistant.openVacancyChatFromNegotiations(page, vacancy);
    const chatText = result.frame
      ? await result.frame.locator('body').innerText({ timeout: 5_000 }).catch(() => '')
      : '';
    const controls = result.frame
      ? await result.frame.locator('button, [role="button"], input').evaluateAll((nodes) => nodes
        .map((node) => ({
          tag: node.tagName,
          dataQa: node.getAttribute('data-qa') || '',
          role: node.getAttribute('role') || '',
          type: node.getAttribute('type') || '',
          text: (node.textContent || node.getAttribute('value') || '').replace(/\s+/g, ' ').trim(),
        }))
        .filter((item) => item.text || item.dataQa))
      : [];
    process.stderr.write(`Chat found: ${result.found}; frame: ${Boolean(result.frame)}\n`);
    process.stdout.write(`${JSON.stringify({ found: result.found, rejected: result.rejected, chatText, controls }, null, 2)}\n`);
  } finally {
    await assistant.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
