import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BrainCircuit,
  Check,
  ChevronLeft,
  ExternalLink,
  Loader2,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  countUnansweredHhScreeningQuestions,
  hhScreeningRelocationScope,
  hhScreeningSemanticKey,
  HH_SCREENING_DRAFTS_STORAGE_KEY,
  isHhAiQuotaMessage,
  isHhScreeningAnswerComplete,
  readHhScreeningDrafts,
  summarizePendingHhScreening,
  uniqueHhScreeningQuestions,
} from '../lib/hhScreening';
import { pluralRu } from '../lib/pluralRu';
import type {
  HhAssistantState,
  HhQueueItem,
  HhScreeningDraftSuggestion,
  HhScreeningQuestion,
} from '../types/electron';

interface ScreeningDraft {
  answer: string;
  selectedOptions: string[];
}

function draftKey(vacancyKey: string, questionId: string): string {
  return `${vacancyKey}::${questionId}`;
}

function isComplete(question: HhScreeningQuestion, value: ScreeningDraft | undefined): boolean {
  return isHhScreeningAnswerComplete(question, value?.answer, value?.selectedOptions);
}

function questionExplanation(question: HhScreeningQuestion): string {
  const reason = question.assistantReason?.trim() ?? '';
  if (isHhAiQuotaMessage(reason)) {
    return 'Онлайн-ИИ достиг месячного лимита. SkillCue всё равно использует резюме, сохранённые факты и локальные безопасные шаблоны; личные сведения не выдумывает.';
  }
  if (/не удалось получить|timed out|timeout|http\s*5\d\d/i.test(reason)) {
    return 'SkillCue не получил надёжный ответ автоматически. Проверьте этот факт один раз — дальше он останется в профиле.';
  }
  if (reason) return reason;
  return 'Этого факта нет в резюме и подтверждённых ответах. SkillCue не будет придумывать его за вас.';
}

function cleanRemoteError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const cleaned = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  return cleaned || fallback;
}

function suggestionErrorMessage(error: unknown): string {
  return cleanRemoteError(error, 'Не удалось подготовить вариант ответа.');
}

export default function HhHrProfilePage() {
  const assistant = window.electronAPI?.hhAssistant;
  const navigate = useNavigate();
  const [state, setState] = useState<HhAssistantState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ScreeningDraft>>(readHhScreeningDrafts);
  const [activeVacancyKey, setActiveVacancyKey] = useState('');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [remember, setRemember] = useState(true);
  const [submittingVacancyKeys, setSubmittingVacancyKeys] = useState<string[]>([]);
  const [suggestingDraftKey, setSuggestingDraftKey] = useState('');
  const [forgettingFactId, setForgettingFactId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [generatedSuggestions, setGeneratedSuggestions] = useState<Record<string, HhScreeningDraftSuggestion>>({});
  const suggestionRequestId = useRef(0);

  useEffect(() => {
    if (!assistant) return;
    let active = true;
    setLoading(true);
    void assistant.getState()
      .then((next) => {
        if (!active) return;
        setState(next);
        setError('');
      })
      .catch((loadError) => {
        if (active) setError(cleanRemoteError(loadError, 'Не удалось загрузить вопросы работодателей.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const unsubscribe = assistant.onState((next) => {
      if (!active) return;
      setState(next);
      setLoading(false);
    });
    return () => { active = false; unsubscribe(); };
  }, [assistant, reloadKey]);

  const screeningSummary = useMemo(
    () => summarizePendingHhScreening(state?.queue ?? []),
    [state?.queue],
  );
  const pendingVacancies = screeningSummary.vacancies;
  const totalQuestions = countUnansweredHhScreeningQuestions(screeningSummary, drafts);
  const activeVacancy = pendingVacancies.find((item) => item.key === activeVacancyKey)
    ?? pendingVacancies[0]
    ?? null;
  const rawQuestions = activeVacancy?.pendingQuestions ?? [];
  const questions = uniqueHhScreeningQuestions(rawQuestions);
  const currentQuestion = questions[Math.min(questionIndex, Math.max(0, questions.length - 1))] ?? null;
  const currentDraftKey = activeVacancy && currentQuestion
    ? draftKey(activeVacancy.key, currentQuestion.id)
    : '';
  const currentDraft = currentDraftKey ? drafts[currentDraftKey] : undefined;
  const hasWrittenAnswer = currentQuestion?.kind === 'text' && Boolean(currentDraft?.answer.trim());
  const answeredInVacancy = activeVacancy
    ? questions.filter((question) => isComplete(question, drafts[draftKey(activeVacancy.key, question.id)])).length
    : 0;
  const activeVacancySubmitting = activeVacancy
    ? submittingVacancyKeys.includes(activeVacancy.key)
    : false;
  const similarQuestionCount = currentQuestion
    ? pendingVacancies.reduce((total, vacancy) => total + (vacancy.pendingQuestions ?? []).filter(
        (question) => hhScreeningSemanticKey(question.prompt) === hhScreeningSemanticKey(currentQuestion.prompt),
      ).length, 0) - 1
    : 0;

  useEffect(() => {
    if (!activeVacancy) return;
    if (activeVacancy.key !== activeVacancyKey) {
      setActiveVacancyKey(activeVacancy.key);
      setQuestionIndex(0);
    }
  }, [activeVacancy, activeVacancyKey]);

  useEffect(() => {
    setQuestionIndex((current) => Math.max(0, Math.min(current, Math.max(0, questions.length - 1))));
  }, [questions.length]);

  useEffect(() => {
    setDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const vacancy of pendingVacancies) {
        for (const question of vacancy.pendingQuestions ?? []) {
          const key = draftKey(vacancy.key, question.id);
          if (next[key]) continue;
          if (!question.suggestedAnswer && !(question.suggestedOptions?.length)) continue;
          next[key] = {
            answer: question.suggestedAnswer ?? '',
            selectedOptions: question.suggestedOptions ?? [],
          };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [pendingVacancies]);

  useEffect(() => {
    localStorage.setItem(HH_SCREENING_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  }, [drafts]);

  const selectVacancy = (vacancy: HhQueueItem) => {
    suggestionRequestId.current += 1;
    setSuggestingDraftKey('');
    setActiveVacancyKey(vacancy.key);
    const firstMissing = uniqueHhScreeningQuestions(vacancy.pendingQuestions ?? []).findIndex(
      (question) => !isComplete(question, drafts[draftKey(vacancy.key, question.id)]),
    );
    setQuestionIndex(firstMissing >= 0 ? firstMissing : 0);
    setError('');
    setNotice('');
  };

  const updateText = (answer: string) => {
    if (!activeVacancy || !currentQuestion) return;
    const key = draftKey(activeVacancy.key, currentQuestion.id);
    if (suggestingDraftKey === key) {
      suggestionRequestId.current += 1;
      setSuggestingDraftKey('');
    }
    setDrafts((current) => ({
      ...current,
      [key]: { answer, selectedOptions: current[key]?.selectedOptions ?? [] },
    }));
    setGeneratedSuggestions((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setError('');
  };

  const updateOption = (option: string) => {
    if (!activeVacancy || !currentQuestion) return;
    const key = draftKey(activeVacancy.key, currentQuestion.id);
    if (suggestingDraftKey === key) {
      suggestionRequestId.current += 1;
      setSuggestingDraftKey('');
    }
    setDrafts((current) => {
      const value = current[key] ?? { answer: '', selectedOptions: [] };
      const selectedOptions = currentQuestion.kind === 'multiple'
        ? value.selectedOptions.includes(option)
          ? value.selectedOptions.filter((item) => item !== option)
          : [...value.selectedOptions, option]
        : [option];
      return { ...current, [key]: { ...value, selectedOptions } };
    });
    setError('');
  };

  const moveQuestion = (direction: -1 | 1) => {
    if (!currentQuestion || !activeVacancy) return;
    if (direction > 0 && !isComplete(currentQuestion, drafts[draftKey(activeVacancy.key, currentQuestion.id)])) {
      setError('Ответьте на этот вопрос — SkillCue сохранит факт и больше не спросит его повторно.');
      return;
    }
    suggestionRequestId.current += 1;
    setSuggestingDraftKey('');
    setQuestionIndex((current) => {
      if (direction < 0) return Math.max(0, current - 1);
      const nextMissing = questions.findIndex((question, index) =>
        index > current && !isComplete(question, drafts[draftKey(activeVacancy.key, question.id)]));
      return nextMissing >= 0 ? nextMissing : Math.min(questions.length - 1, current + 1);
    });
    setError('');
  };

  const suggestCurrentAnswer = async () => {
    if (!assistant || !activeVacancy || !currentQuestion) return;
    const key = draftKey(activeVacancy.key, currentQuestion.id);
    const requestId = suggestionRequestId.current + 1;
    suggestionRequestId.current = requestId;
    setSuggestingDraftKey(key);
    setError('');
    try {
      const suggestion = await assistant.suggestScreeningAnswer(
        activeVacancy.key,
        currentQuestion.id,
        currentQuestion.kind === 'text' ? drafts[key]?.answer ?? '' : undefined,
      );
      if (suggestionRequestId.current !== requestId) return;
      setDrafts((current) => ({
        ...current,
        [key]: {
          answer: suggestion.answer,
          selectedOptions: suggestion.selectedOptions,
        },
      }));
      setGeneratedSuggestions((current) => ({ ...current, [key]: suggestion }));
    } catch (suggestionError) {
      if (suggestionRequestId.current === requestId) {
        setError(suggestionErrorMessage(suggestionError));
      }
    } finally {
      if (suggestionRequestId.current === requestId) {
        setSuggestingDraftKey('');
      }
    }
  };

  const submitVacancy = async () => {
    if (!assistant || !activeVacancy || questions.length === 0) return;
    const firstMissing = questions.findIndex(
      (question) => !isComplete(question, drafts[draftKey(activeVacancy.key, question.id)]),
    );
    if (firstMissing >= 0) {
      setQuestionIndex(firstMissing);
      setError('Сначала ответьте на оставшийся вопрос. Черновики уже сохранены на этом устройстве.');
      return;
    }
    const vacancyKey = activeVacancy.key;
    suggestionRequestId.current += 1;
    setSuggestingDraftKey('');
    setSubmittingVacancyKeys((current) => current.includes(vacancyKey) ? current : [...current, vacancyKey]);
    setError('');
    try {
      const next = await assistant.answerScreeningQuestions(
        vacancyKey,
        questions.map((question) => {
          const value = drafts[draftKey(activeVacancy.key, question.id)]!;
          return {
            questionId: question.id,
            question: question.prompt,
            answer: value.answer.trim(),
            selectedOptions: value.selectedOptions,
            remember,
          };
        }),
      );
      const nextVacancies = summarizePendingHhScreening(next.queue).vacancies;
      const nextVacancy = nextVacancies.find((item) => item.key !== vacancyKey) ?? null;
      setState(next);
      setDrafts((current) => {
        const nextDrafts = { ...current };
        for (const question of rawQuestions) delete nextDrafts[draftKey(activeVacancy.key, question.id)];
        return nextDrafts;
      });
      setActiveVacancyKey(nextVacancy?.key ?? '');
      setQuestionIndex(0);
      setNotice(nextVacancy
        ? `Ответы отправлены. Открыта следующая вакансия: ${nextVacancy.title}.`
        : 'Ответы отправлены. Вопросов, требующих вашего решения, больше нет.');
      window.setTimeout(() => {
        document.getElementById('hr-profile-current-question')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 0);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Не удалось сохранить ответы и продолжить отклик.');
    } finally {
      setSubmittingVacancyKeys((current) => current.filter((key) => key !== vacancyKey));
    }
  };

  const forgetFact = async (factId: string) => {
    if (!assistant) return;
    setError('');
    setForgettingFactId(factId);
    try {
      setState(await assistant.forgetScreeningFact(factId));
    } catch (forgetError) {
      setError(cleanRemoteError(forgetError, 'Не удалось удалить сохранённый факт.'));
    } finally {
      setForgettingFactId((current) => current === factId ? '' : current);
    }
  };

  if (!assistant) {
    return <div className="panel-card p-6 text-sm text-red-300">Профиль для HR недоступен в браузерной версии.</div>;
  }

  if (loading && !state) {
    return <div className="panel-card flex min-h-56 items-center justify-center gap-3 p-8 text-sm text-ink-muted"><Loader2 className="animate-spin text-violet-300" size={20} />Загружаю вопросы работодателей…</div>;
  }

  if (!state) {
    return <div className="space-y-4"><button type="button" className="btn-ghost btn-sm" onClick={() => navigate('/applications')}><ArrowLeft size={14} />К откликам</button><section className="panel-card p-8 text-center"><AlertTriangle className="mx-auto text-red-300" size={28} /><h1 className="mt-4 text-lg font-semibold text-ink">Не удалось загрузить вопросы</h1><p className="mt-2 text-sm text-ink-muted">{error || 'Фоновый сервис временно не ответил.'}</p><button type="button" className="btn-secondary mt-5" onClick={() => setReloadKey((current) => current + 1)}>Повторить</button></section></div>;
  }

  return (
    <div className="space-y-5 pb-10">
      <button type="button" className="btn-ghost btn-sm" onClick={() => navigate('/applications')}>
        <ArrowLeft size={14} />К откликам
      </button>

      <header className="hr-profile-hero panel-card overflow-hidden p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="hr-knowledge-orb grid h-11 w-11 shrink-0 place-items-center rounded-xl text-violet-100">
            <BrainCircuit size={22} />
          </div>
          <div className="min-w-[240px] flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-ink">Вопросы работодателей</h1>
            </div>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
              {pendingVacancies.length} {pluralRu(pendingVacancies.length, 'отклик ждёт', 'отклика ждут', 'откликов ждут')} ответа. После отправки сразу откроется следующая вакансия.
            </p>
          </div>
          <div className="flex gap-2">
            <div className="rounded-xl border border-surface-border bg-surface-light px-4 py-2.5 text-center">
              <b className="block text-lg text-ink">{state?.screeningFacts.length ?? 0}</b>
              <span className="text-[10px] uppercase tracking-wide text-ink-faint">SkillCue знает</span>
            </div>
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-4 py-2.5 text-center">
              <b className="block text-lg text-amber-100">{totalQuestions}</b>
              <span className="text-[10px] uppercase tracking-wide text-ink-faint">нужно уточнить</span>
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.035] px-3.5 py-2.5 text-xs text-emerald-200">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.7)]" />
          Эти вопросы не останавливают поиск и обработку остальных вакансий.
        </div>
        {screeningSummary.quotaLimitedCount > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-3 text-xs leading-relaxed text-amber-100">
            <Sparkles className="mt-0.5 shrink-0" size={15} />
            <span><b>Онлайн-ИИ временно ограничен тарифом.</b> Это не означает, что SkillCue не знает ваш профиль: ответы из резюме и сохранённых фактов продолжают подставляться. Для {screeningSummary.quotaLimitedCount} {screeningSummary.quotaLimitedCount === 1 ? 'уникального вопроса' : 'уникальных вопросов'} доступен локальный черновик, если его можно составить без выдумывания фактов.</span>
          </div>
        )}
      </header>

      {error && <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/[0.05] px-4 py-3 text-sm text-red-300" role="alert"><AlertTriangle className="mt-0.5 shrink-0" size={16} /><span>{error}</span></div>}
      {notice && <div className="flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] px-4 py-3 text-sm text-emerald-200" role="status"><Check className="mt-0.5 shrink-0" size={16} /><span>{notice}</span></div>}

      {pendingVacancies.length === 0 ? (
        <section className="panel-card p-8 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-400/10 text-emerald-300">
            <Check size={27} />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-ink">Новых вопросов нет</h2>
          <p className="mt-1 text-sm text-ink-muted">SkillCue может продолжать отклики без вашего участия.</p>
          <button type="button" className="btn-primary mt-5" onClick={() => navigate('/applications')}>
            Вернуться к откликам<ArrowRight size={15} />
          </button>
        </section>
      ) : (
        <>
          {pendingVacancies.length > 4 ? (
            <nav className="panel-card flex flex-wrap items-center gap-3 px-4 py-3" aria-label="Вакансии с новыми вопросами">
              <label className="shrink-0" htmlFor="screening-vacancy-select">
                <span className="block text-xs font-semibold text-ink">Вакансия с вопросами</span>
                <span className="mt-0.5 block text-[11px] text-ink-faint">Выберите, какую разобрать сейчас</span>
              </label>
              <select
                id="screening-vacancy-select"
                className="min-w-[260px] flex-1 rounded-lg border border-surface-border bg-surface-light px-3 py-2.5 text-sm text-ink outline-none transition-colors focus:border-violet-400/55 focus-visible:ring-2 focus-visible:ring-accent-ring"
                value={activeVacancy?.key ?? ''}
                onChange={(event) => {
                  const vacancy = pendingVacancies.find((item) => item.key === event.target.value);
                  if (vacancy) selectVacancy(vacancy);
                }}
              >
                {pendingVacancies.map((vacancy) => {
                  const vacancyQuestions = uniqueHhScreeningQuestions(vacancy.pendingQuestions ?? []);
                  const completed = vacancyQuestions.filter(
                    (question) => isComplete(question, drafts[draftKey(vacancy.key, question.id)]),
                  ).length;
                  return (
                    <option key={vacancy.key} value={vacancy.key}>
                      {vacancy.title} · {vacancy.company} · {completed}/{vacancyQuestions.length}
                    </option>
                  );
                })}
              </select>
              <span className="shrink-0 rounded-full border border-amber-400/20 bg-amber-400/[0.05] px-2.5 py-1 text-xs text-amber-100">
                {pendingVacancies.length} {pluralRu(pendingVacancies.length, 'вакансия', 'вакансии', 'вакансий')}
              </span>
            </nav>
          ) : (
            <nav className="flex flex-wrap gap-2" aria-label="Вакансии с новыми вопросами">
              {pendingVacancies.map((vacancy) => {
                const vacancyQuestions = uniqueHhScreeningQuestions(vacancy.pendingQuestions ?? []);
                const completed = vacancyQuestions.filter(
                  (question) => isComplete(question, drafts[draftKey(vacancy.key, question.id)]),
                ).length;
                const selected = vacancy.key === activeVacancy?.key;
                return (
                  <button
                    key={vacancy.key}
                    type="button"
                    className={`min-w-[190px] flex-1 rounded-xl border px-3.5 py-3 text-left transition-[color,background-color,border-color,box-shadow] ${selected ? 'border-violet-400/45 bg-violet-400/[0.08] shadow-[0_8px_30px_rgba(124,58,237,.08)]' : 'border-surface-border bg-surface-light hover:border-surface-border-strong hover:bg-surface-hover'}`}
                    onClick={() => selectVacancy(vacancy)}
                  >
                    <span className="block truncate text-xs font-semibold text-ink">{vacancy.title}</span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-faint">
                      <span className="truncate">{vacancy.company}</span>
                      <span className={completed === vacancyQuestions.length ? 'text-emerald-300' : 'text-amber-100'}>{completed}/{vacancyQuestions.length}</span>
                    </span>
                  </button>
                );
              })}
            </nav>
          )}

          {activeVacancy && currentQuestion && (
            <section key={`${activeVacancy.key}-${currentQuestion.id}`} className="hr-profile-question panel-card overflow-hidden">
              <div className="h-1 bg-surface-elevated">
                <div
                  className="hr-profile-progress h-full rounded-r-full"
                  style={{ width: `${Math.max(6, ((questionIndex + 1) / questions.length) * 100)}%` }}
                />
              </div>
              <div className="p-5 sm:p-7">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-violet-300">Вопрос {questionIndex + 1} из {questions.length}</p>
                    <p className="mt-1 text-xs text-ink-faint">{activeVacancy.title} · {activeVacancy.company}</p>
                  </div>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => {
                    setError('');
                    void assistant.openVacancy(activeVacancy.key).catch((openError) => {
                      setError(cleanRemoteError(openError, 'Не удалось открыть вакансию.'));
                    });
                  }}>
                    <ExternalLink size={13} />Вакансия
                  </button>
                </div>

                <h2 id="hr-profile-current-question" className="mt-5 max-w-4xl text-lg font-semibold leading-relaxed text-ink">{currentQuestion.prompt}</h2>
                {similarQuestionCount > 0 && (
                  <div className="mt-3 flex max-w-4xl items-start gap-2 rounded-xl border border-sky-400/20 bg-sky-400/[0.045] px-3.5 py-3 text-xs leading-relaxed text-sky-200">
                    <ShieldCheck className="mt-0.5 shrink-0" size={15} />
                    <span><b>{hhScreeningRelocationScope(currentQuestion.prompt) === 'russia' ? 'Общее условие о переезде по России.' : 'Похожий вопрос уже сгруппирован.'}</b> Этот ответ будет применён ещё к {similarQuestionCount} {pluralRu(similarQuestionCount, 'похожему вопросу', 'похожим вопросам', 'похожим вопросам')} — повторно отвечать не придётся.</span>
                  </div>
                )}
                <div className="mt-3 flex max-w-4xl items-start gap-2 rounded-xl border border-violet-400/15 bg-violet-400/[0.035] px-3.5 py-3 text-xs leading-relaxed text-ink-muted">
                  <Sparkles className="mt-0.5 shrink-0 text-violet-300" size={15} />
                  <span><b className="text-ink">Почему нужен ответ:</b> {questionExplanation(currentQuestion)}</span>
                </div>

                <div className="mt-5 max-w-4xl">
                  <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-ink-faint">
                      {hasWrittenAnswer
                        ? 'SkillCue сохранит ваши факты и смысл, но сделает ответ яснее и профессиональнее.'
                        : 'Напишите сами или возьмите подходящий черновик за основу.'}
                    </p>
                    <button
                      type="button"
                      className="btn-secondary btn-sm border-violet-400/25 text-violet-100 hover:border-violet-400/45"
                      disabled={Boolean(suggestingDraftKey) || activeVacancySubmitting}
                      onClick={() => void suggestCurrentAnswer()}
                    >
                      {suggestingDraftKey === draftKey(activeVacancy.key, currentQuestion.id)
                        ? <Loader2 className="animate-spin" size={14} />
                        : <Sparkles size={14} />}
                      {suggestingDraftKey === draftKey(activeVacancy.key, currentQuestion.id)
                        ? hasWrittenAnswer ? 'Улучшаю ваш ответ…' : 'Готовлю черновик…'
                        : hasWrittenAnswer
                          ? 'Улучшить мой ответ'
                          : 'Предложить безопасный черновик'}
                    </button>
                  </div>
                  {currentQuestion.kind === 'text' ? (
                    <textarea
                      className="field min-h-32 resize-y text-sm leading-relaxed"
                      aria-labelledby="hr-profile-current-question"
                      maxLength={2000}
                      value={drafts[draftKey(activeVacancy.key, currentQuestion.id)]?.answer ?? ''}
                      onChange={(event) => updateText(event.target.value)}
                      placeholder="Ответьте своими словами. SkillCue сохранит смысл и использует его в следующих анкетах."
                    />
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {currentQuestion.options.map((option) => {
                        const selected = drafts[draftKey(activeVacancy.key, currentQuestion.id)]?.selectedOptions.includes(option) ?? false;
                        return (
                          <label key={option} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3.5 text-sm transition-[color,background-color,border-color] ${selected ? 'border-emerald-400/40 bg-emerald-400/[0.07] text-ink' : 'border-surface-border bg-surface-light text-ink-muted hover:bg-surface-hover'}`}>
                            <input
                              type={currentQuestion.kind === 'multiple' ? 'checkbox' : 'radio'}
                              name={`${activeVacancy.key}-${currentQuestion.id}`}
                              checked={selected}
                              onChange={() => updateOption(option)}
                              className="mt-0.5 h-4 w-4 accent-emerald-500"
                            />
                            <span>{option}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {currentQuestion.kind === 'text' && hasWrittenAnswer && (
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-200">
                      <Check size={12} />Ответ принят. Короткие ответы «Да» и «Нет» тоже можно сохранять.
                    </p>
                  )}
                  {generatedSuggestions[draftKey(activeVacancy.key, currentQuestion.id)] ? (
                    <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-300/15 bg-amber-300/[0.035] px-3 py-2.5 text-[11px] leading-relaxed text-amber-100">
                      <Sparkles className="mt-0.5 shrink-0" size={13} />
                      <span>
                        <b>{generatedSuggestions[draftKey(activeVacancy.key, currentQuestion.id)].source === 'ai' ? 'ИИ-черновик: ' : 'Черновик SkillCue: '}</b>
                        {generatedSuggestions[draftKey(activeVacancy.key, currentQuestion.id)].note}
                      </span>
                    </div>
                  ) : currentQuestion.suggestedAnswer && (
                    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-violet-200">
                      <Sparkles size={12} />SkillCue подготовил черновик — проверьте его перед сохранением.
                    </p>
                  )}
                </div>

                <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-surface-border pt-5">
                  <button type="button" className="btn-ghost" disabled={questionIndex === 0 || activeVacancySubmitting} onClick={() => moveQuestion(-1)}>
                    <ChevronLeft size={15} />Назад
                  </button>
                  {questionIndex < questions.length - 1 ? (
                    <button type="button" className="btn-primary" disabled={activeVacancySubmitting} onClick={() => moveQuestion(1)}>
                      Сохранить ответ и перейти к вопросу {questionIndex + 2}<ArrowRight size={15} />
                    </button>
                  ) : (
                    <button type="button" className="btn-primary" disabled={activeVacancySubmitting} onClick={() => void submitVacancy()}>
                      {activeVacancySubmitting ? <Loader2 className="animate-spin" size={15} /> : <Send size={15} />}
                      Отправить {answeredInVacancy} из {questions.length} ответов и продолжить отклик
                    </button>
                  )}
                  <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
                    <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="h-4 w-4 accent-emerald-500" />
                    Запомнить в профиле
                  </label>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {(state?.screeningFacts.length ?? 0) > 0 && (
        <details className="group panel-card overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-3 p-4 text-sm font-medium text-ink hover:bg-surface-hover/30">
            <ShieldCheck size={17} className="text-emerald-300" />
            Что SkillCue уже знает
            <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-[11px] text-ink-muted">{state?.screeningFacts.length}</span>
            <span className="ml-auto text-xs text-ink-faint group-open:hidden">Показать</span>
            <span className="ml-auto hidden text-xs text-ink-faint group-open:inline">Скрыть</span>
          </summary>
          <div className="grid gap-2 border-t border-surface-border p-4 sm:grid-cols-2">
            {state?.screeningFacts.map((fact) => (
              <div key={fact.id} className="flex items-start gap-3 rounded-xl border border-surface-border bg-surface-light p-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium leading-relaxed text-ink">{fact.question}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{fact.selectedOptions.length > 0 ? fact.selectedOptions.join(', ') : fact.answer}</p>
                </div>
                <button type="button" className="btn-ghost btn-sm shrink-0 text-red-300" aria-label="Удалить сохранённый факт" disabled={forgettingFactId === fact.id} onClick={() => void forgetFact(fact.id)}>
                  {forgettingFactId === fact.id ? <Loader2 className="animate-spin" size={13} /> : <Trash2 size={13} />}
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
