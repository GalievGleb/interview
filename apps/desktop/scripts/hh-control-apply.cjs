const path = require('node:path');

const { HhBrowserAssistant } = require('../dist-electron/hhBrowserAssistant.js');
const { buildGroundedLocalHhCoverLetter } = require('../dist-electron/hhCoverLetter.js');

async function main() {
  const vacancyId = process.argv[2];
  if (!vacancyId) throw new Error('Usage: node scripts/hh-control-apply.cjs <vacancy-id>');

  const userDataDir = path.join(process.env.APPDATA, 'SkillCue Dev');
  let generated = null;
  const assistant = new HhBrowserAssistant(
    userDataDir,
    () => undefined,
    undefined,
    async (request) => {
      generated = buildGroundedLocalHhCoverLetter(request);
      return generated;
    },
  );

  try {
    const state = await assistant.applyOne(vacancyId);
    const vacancy = state.queue.find((item) => item.id === vacancyId || item.key === vacancyId);
    process.stdout.write(`${JSON.stringify({ vacancy, generated }, null, 2)}\n`);
  } finally {
    await assistant.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
