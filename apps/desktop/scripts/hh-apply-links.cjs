const path = require('node:path');

const { HhBrowserAssistant } = require('../dist-electron/hhBrowserAssistant.js');
const { buildGroundedLocalHhCoverLetter } = require('../dist-electron/hhCoverLetter.js');

async function main() {
  const ids = [...new Set(process.argv.slice(2))];
  if (!ids.length) throw new Error('Usage: node scripts/hh-apply-links.cjs <vacancy-id...>');
  const generatedById = new Map();
  let currentId = '';
  const assistant = new HhBrowserAssistant(
    path.join(process.env.APPDATA, 'SkillCue Dev'),
    (state) => {
      if (state.currentVacancyId) currentId = String(state.currentVacancyId).replace(/^hh:/, '');
    },
    undefined,
    async (request) => {
      const generated = buildGroundedLocalHhCoverLetter(request);
      if (currentId) generatedById.set(currentId, generated);
      return generated;
    },
  );
  const results = [];
  try {
    for (const id of ids) {
      currentId = id;
      const state = await assistant.applyVacancyUrl(`https://hh.ru/vacancy/${id}`);
      const vacancy = state.queue.find((item) => item.id === id);
      results.push({ vacancy, generated: generatedById.get(id) ?? null });
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
