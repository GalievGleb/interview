const path = require('node:path');

const { HhBrowserAssistant } = require('../dist-electron/hhBrowserAssistant.js');
const { findSalaryExpectation } = require('../dist-electron/hhScreeningKnowledge.js');

async function main() {
  const vacancyTitle = process.argv.slice(2).join(' ').trim() || 'QA Automation Engineer';
  const assistant = new HhBrowserAssistant(
    path.join(process.env.APPDATA, 'SkillCue Dev'),
    () => undefined,
  );
  try {
    const resumes = await assistant.getApplicantResumes();
    const resumeText = await assistant.getSelectedResumeText(vacancyTitle);
    const salary = findSalaryExpectation(null, [resumeText]);
    process.stdout.write(`${JSON.stringify({
      vacancyTitle,
      resumes: resumes.map((resume) => ({ id: resume.id, title: resume.title })),
      selectedSalary: salary,
      salaryContexts: resumeText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /(?:₽|руб(?:\.|лей|ля)?|зарплат|доход|оклад)/i.test(line))
        .slice(0, 10),
      experienceContexts: resumeText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /(?:опыт работы|год|года|лет|месяц)/i.test(line))
        .slice(0, 15),
    }, null, 2)}\n`);
  } finally {
    await assistant.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
