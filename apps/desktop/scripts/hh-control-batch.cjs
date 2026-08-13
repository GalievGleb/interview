const path = require('node:path');

const { HhBrowserAssistant } = require('../dist-electron/hhBrowserAssistant.js');
const { buildGroundedLocalHhCoverLetter } = require('../dist-electron/hhCoverLetter.js');

async function main() {
  const userDataDir = path.join(process.env.APPDATA, 'SkillCue Dev');
  let lastVacancyId = '';
  const assistant = new HhBrowserAssistant(
    userDataDir,
    (state) => {
      if (state.currentVacancyId && state.currentVacancyId !== lastVacancyId) {
        lastVacancyId = state.currentVacancyId;
        process.stdout.write(`CHECK ${state.currentVacancyId}: ${state.message}\n`);
      }
    },
    undefined,
    async (request) => buildGroundedLocalHhCoverLetter(request),
  );

  try {
    const scopedKeys = new Set(
      assistant.state.queue
        .filter((item) => ['new', 'opened', 'prepared'].includes(item.status))
        .map((item) => item.key),
    );
    process.stdout.write(`CONTROL_BATCH ${scopedKeys.size}\n`);
    const stats = await assistant.runQueue(undefined, scopedKeys);
    const state = assistant.getState();
    const recent = state.queue
      .filter((item) => item.sentAt)
      .sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))
      .slice(0, 10)
      .map(({ id, title, company, status, sentAt, coverLetterAdded }) => ({
        id, title, company, status, sentAt, coverLetterAdded,
      }));
    process.stdout.write(`${JSON.stringify({ stats, message: state.message, recent }, null, 2)}\n`);
  } finally {
    await assistant.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
