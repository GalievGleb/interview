import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const profileSource = fs.readFileSync(path.resolve(__dirname, 'HhHrProfilePage.tsx'), 'utf8');
const applicationsSource = fs.readFileSync(path.resolve(__dirname, 'HhApplicationsPage.tsx'), 'utf8');
const appSource = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
const assistantSource = fs.readFileSync(
  path.resolve(__dirname, '../../electron/hhBrowserAssistant.ts'),
  'utf8',
);
const knowledgeSource = fs.readFileSync(
  path.resolve(__dirname, '../../electron/hhScreeningKnowledge.ts'),
  'utf8',
);
const mainSource = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve(__dirname, '../../electron/preload.ts'), 'utf8');
const electronTypesSource = fs.readFileSync(path.resolve(__dirname, '../types/electron.d.ts'), 'utf8');

describe('HR profile question flow', () => {
  it('keeps the vacancy page compact and opens a dedicated profile route', () => {
    expect(applicationsSource).toContain("'отклик ждёт', 'отклика ждут', 'откликов ждут'");
    expect(applicationsSource).toContain("navigate('/applications/hr-profile')");
    expect(applicationsSource).toContain('Поиск и другие отклики продолжаются.');
    expect(applicationsSource).toContain('Открыть все вопросы');
    expect(applicationsSource).toContain("overview.tone === 'active' ? 'btn-danger' : 'btn-primary'");
    expect(applicationsSource).toContain("overview.tone !== 'active' && <ArrowRight");
    expect(applicationsSource).not.toContain("className={`${activeRun ? 'btn-danger' : 'btn-primary'}");
    expect(applicationsSource).not.toContain('Ответить один раз</');
    expect(appSource).toContain('path="/applications/hr-profile"');
    expect(appSource).toContain("import('./pages/HhHrProfilePage')");
  });

  it('shows one question at a time and persists unfinished drafts locally', () => {
    expect(profileSource).toContain('Вопрос {questionIndex + 1} из {questions.length}');
    expect(profileSource).toContain('HH_SCREENING_DRAFTS_STORAGE_KEY');
    expect(profileSource).toContain('localStorage.setItem(HH_SCREENING_DRAFTS_STORAGE_KEY');
    expect(profileSource).toContain('countUnansweredHhScreeningQuestions(screeningSummary, drafts)');
    expect(profileSource).toContain('Сохранить ответ и перейти к вопросу');
    expect(profileSource).toContain('ответов и продолжить отклик');
    expect(profileSource).not.toContain('autoFocus');
    expect(profileSource).toContain('uniqueHhScreeningQuestions(rawQuestions)');
    expect(profileSource).toContain('Общее условие о переезде по России.');
    expect(profileSource).toContain('nextMissing');
  });

  it('does not lock a new questionnaire while another vacancy is being submitted', () => {
    expect(profileSource).toContain('submittingVacancyKeys.includes(activeVacancy.key)');
    expect(profileSource).toContain('disabled={activeVacancySubmitting}');
    expect(profileSource).not.toContain("const [busy, setBusy] = useState('')");
    expect(profileSource).toContain('Короткие ответы «Да» и «Нет» тоже можно сохранять.');
    expect(profileSource).toContain('const nextVacancies = summarizePendingHhScreening(next.queue).vacancies');
    expect(profileSource).toContain('Ответы отправлены. Открыта следующая вакансия:');
  });

  it('saves confirmed answers as reusable candidate knowledge', () => {
    expect(profileSource).toContain('remember,');
    expect(profileSource).toContain('assistant.answerScreeningQuestions(');
    expect(profileSource).toContain('Сохранённые ответы');
    expect(profileSource).toContain('assistant.forgetScreeningFact(factId)');
    expect(assistantSource).toContain('this.state.screeningFacts = [...facts.values()].slice(-100)');
    expect(assistantSource).toContain('selectRelevantScreeningFacts(');
  });

  it('uses known salary data without turning it into a manual question', () => {
    expect(assistantSource).toContain('findSalaryExpectation(');
    expect(assistantSource).toContain('knownScreeningAnswer(field.question, salaryExpectation, resumeText);');
    expect(knowledgeSource).toContain('explicit setting or HH résumé');
    expect(knowledgeSource).toContain('Рассматриваю предложения от');
  });

  it('splits long tests into bounded AI batches and resumes cards only after an answer exists', () => {
    expect(assistantSource).toContain('representatives.slice(index * 6, index * 6 + 6)');
    expect(assistantSource).toContain('allSettledWithConcurrency(batches, 2');
    const actionableAt = assistantSource.indexOf('const ACTIONABLE_QUEUE_STATUSES');
    const actionableEnd = assistantSource.indexOf(']);', actionableAt);
    expect(assistantSource.slice(actionableAt, actionableEnd)).not.toContain("'needs_input'");
    expect(assistantSource).toContain('isActionableQueueStatus(item.status)');
    expect(assistantSource).toContain("status: pendingQuestions.length === 0 ? 'prepared' as const");
    expect(assistantSource).toContain('this.scheduleQueueResume(2_000)');
    expect(knowledgeSource).toContain('PROFESSIONAL_OPTION_RULES');
    expect(profileSource).toContain('Эти вопросы не останавливают поиск и обработку остальных вакансий');
  });

  it('generates a safe draft for an empty field and refines text already written by the user', () => {
    expect(profileSource).toContain('Предложить безопасный черновик');
    expect(profileSource).toContain('Улучшить мой ответ');
    expect(profileSource).toContain("drafts[key]?.answer ?? ''");
    expect(profileSource).toContain('assistant.suggestScreeningAnswer(');
    expect(profileSource).toContain("replace(/^Error invoking remote method");
    expect(assistantSource).toContain('Это ИИ-предположение, а не подтверждённый факт');
    expect(assistantSource).toContain('async suggestScreeningAnswer(');
    expect(assistantSource).toContain('draftMode: true');
    expect(assistantSource).toContain('existingDraft: {');
    expect(assistantSource).toContain('сохранив исходный смысл и факты');
    expect(knowledgeSource).toContain('localScreeningDraft');
    expect(mainSource).toContain("ipcMain.handle('hh-assistant:suggest-screening-answer'");
    expect(preloadSource).toContain("ipcRenderer.invoke('hh-assistant:suggest-screening-answer'");
    expect(electronTypesSource).toContain('suggestScreeningAnswer: (');
    expect(profileSource).toContain("currentDraft?.answer && currentDraft.selectedOptions.length === 0");
    expect(profileSource).toContain('<span>{currentDraft.answer}</span>');
    expect(assistantSource).toContain('buildHhScreeningReviewDraft(question');
  });

  it('requires explicit acceptance before a generated suggestion is complete', () => {
    expect(profileSource).toContain('confirmedByUser: false');
    expect(profileSource).toContain('confirmedByUser: true');
    expect(profileSource).toContain('Использовать этот вариант');
    expect(profileSource).toContain('onClick={confirmCurrentDraft}');
    expect(profileSource).toContain('reconcileHhScreeningLocalDraft(question, next[key])');
    expect(profileSource).not.toContain('if (next[key]) continue');
  });

  it('shows recoverable errors instead of an empty or falsely completed profile', () => {
    expect(profileSource).toContain("setError(cleanRemoteError(loadError, 'Не удалось загрузить вопросы работодателей.'))");
    expect(profileSource).toContain('Загружаю вопросы работодателей…');
    expect(profileSource).toContain('Не удалось загрузить вопросы');
    expect(profileSource).toContain('setReloadKey((current) => current + 1)');
    expect(profileSource).toContain("setError(cleanRemoteError(forgetError, 'Не удалось удалить сохранённый факт.'))");
    expect(profileSource).toContain("setError(cleanRemoteError(openError, 'Не удалось открыть вакансию.'))");
  });
});
