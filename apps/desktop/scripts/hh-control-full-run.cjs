const path = require('node:path');

const { HhBrowserAssistant } = require('../dist-electron/hhBrowserAssistant.js');
const { buildGroundedLocalHhCoverLetter } = require('../dist-electron/hhCoverLetter.js');

async function main() {
  const userDataDir = path.join(process.env.APPDATA, 'SkillCue Dev');
  let lastProgress = '';
  const assistant = new HhBrowserAssistant(
    userDataDir,
    (state) => {
      const progress = state.phase === 'scanning'
        ? `${state.phase}:${state.message}`
        : state.currentVacancyId
          ? `${state.phase}:${state.currentVacancyId}:${state.message}`
          : '';
      if (progress && progress !== lastProgress) {
        lastProgress = progress;
        process.stdout.write(`${progress}\n`);
      }
    },
    undefined,
    async (request) => buildGroundedLocalHhCoverLetter(request),
  );

  try {
    const before = assistant.getState();
    const sentBefore = new Set(before.queue.filter((item) => item.status === 'sent').map((item) => item.id));
    const result = await assistant.runNow('manual');
    const sentNow = result.queue
      .filter((item) => item.status === 'sent' && !sentBefore.has(item.id))
      .map(({ id, title, company, sentAt, coverLetterAdded }) => ({
        id, title, company, sentAt, coverLetterAdded,
      }));
    const unresolved = result.queue
      .filter((item) => ['new', 'opened', 'prepared', 'needs_input'].includes(item.status))
      .map(({ id, title, company, status, reason, coverLetterPending, pendingQuestions }) => ({
        id,
        title,
        company,
        status,
        reason,
        coverLetterPending,
        questions: pendingQuestions?.length ?? 0,
      }));
    const linkedExamples = ['136144274', '136143010'].map((id) => {
      const item = result.queue.find((vacancy) => vacancy.id === id);
      return item
        ? { id, title: item.title, company: item.company, status: item.status, reason: item.reason }
        : { id, missing: true };
    });
    process.stdout.write(`${JSON.stringify({
      lastScanSummary: result.lastScanSummary,
      message: result.message,
      sentNow,
      unresolved,
      linkedExamples,
    }, null, 2)}\n`);
  } finally {
    await assistant.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
