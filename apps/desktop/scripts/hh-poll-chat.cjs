const path = require('node:path');

const { HhBrowserAssistant } = require('../dist-electron/hhBrowserAssistant.js');
const { HhChatBrowser } = require('../dist-electron/hhChatBrowser.js');

async function main() {
  const userDataDir = path.join(process.env.APPDATA, 'SkillCue Dev');
  const assistant = new HhBrowserAssistant(userDataDir, () => undefined);
  const chat = new HhChatBrowser(
    userDataDir,
    () => assistant.getChatPage(),
    async () => '',
    undefined,
    undefined,
    (vacancyTitle) => assistant.getSelectedResumeText(vacancyTitle),
    () => assistant.restoreInteractivePage(),
  );
  try {
    const before = new Set(chat.getState().replyHistory.map((item) => item.id));
    let state = chat.getState();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      state = await chat.pollNow();
      const sentSalary = state.replyHistory.some((item) => (
        !before.has(item.id) && item.source === 'resume_fact'
      ));
      if (sentSalary) break;
    }
    process.stdout.write(`${JSON.stringify({
      error: state.error,
      pendingDecisions: state.pendingDecisions,
      newReplies: state.replyHistory.filter((item) => !before.has(item.id)),
      conversations: state.conversations.filter((item) => item.needsUserInput || /Айдеко/i.test(item.companyName)),
    }, null, 2)}\n`);
  } finally {
    chat.stopPolling();
    await assistant.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
