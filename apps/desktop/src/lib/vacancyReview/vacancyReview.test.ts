import { describe, it, expect, vi } from 'vitest';
import { api } from '../api';
import { extractTopics, detectRole, detectSeniority } from './topicExtraction';
import {
  MAX_DRILL_DEPTH,
  analyzeVacancyMock,
  buildDrillDownQuestion,
  buildSmokePlan,
  drillDepth,
  evaluateAnswer,
  evaluateAnswerMock,
  buildReadinessReport,
} from './vacancyReviewService';
import { readinessLabelFromScore, readinessTone, topicStatusFromScore, topicStatusTone } from './readiness';
import type { SmokeReviewSession, VacancyAnalysis } from './types';

const QA_VACANCY = `QA Automation Engineer (Middle)
Требования:
- Python, Pytest обязательно
- Playwright или Selenium для UI-тестов
- API testing (HTTPX/Requests), Swagger
- SQL, PostgreSQL
- CI/CD (GitLab CI), Docker
- Allure отчёты, Git
- Тест-дизайн, регрессионное и smoke тестирование`;

describe('topic extraction', () => {
  it('derives topics from the vacancy, not a generic list', () => {
    const { topics } = extractTopics(QA_VACANCY);
    const ids = topics.map((t) => t.id);
    expect(ids).toContain('python');
    expect(ids).toContain('pytest');
    expect(ids).toContain('api-testing');
    expect(ids).toContain('cicd');
    expect(ids).toContain('docker');
    // Each topic carries vacancy evidence.
    expect(topics.every((t) => t.vacancyEvidence.length > 0)).toBe(true);
  });

  it('detects role and seniority', () => {
    expect(detectRole(QA_VACANCY)).toMatch(/QA Automation/i);
    expect(detectSeniority(QA_VACANCY, 'QA Automation Engineer')).toBe('middle');
  });

  it('extracts no topics from empty text', () => {
    expect(extractTopics('').topics).toHaveLength(0);
  });

  it('evaluates behavioral answers with STAR semantics and returns a finished answer', () => {
    const analysis: VacancyAnalysis = {
      id: 'behavioral-star',
      vacancyText: 'QA Automation role: teamwork, conflict resolution, ownership, real project examples.',
      targetRole: 'QA Automation Engineer',
      seniorityLevel: 'senior',
      language: 'ru',
      extractedRequirements: ['teamwork', 'conflict resolution', 'ownership'],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'behavioral',
          title: 'Behavioral questions',
          category: 'Behavioral',
          importance: 'high',
          level: 'senior',
          expectedKnowledge: 'STAR answer with situation, conflict, action, result.',
          expectedAnswerPoints: ['Teamwork', 'Conflict', 'Ownership', 'Real example', 'Result'],
          sampleQuestions: ['Расскажите про сложную ситуацию в команде и как вы ее решили.'],
          vacancyEvidence: 'teamwork and conflict resolution',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'QA Automation, API tests, regression, communication with QA and developers.',
      createdAt: Date.now(),
    };
    const [question] = buildSmokePlan(analysis);

    const evaluation = evaluateAnswerMock(
      question,
      'На проекте личного кабинета я работал вместе с manual QA, разработчиками и аналитиком. Был спор по приоритетам: разработчики хотели быстрее закрыть релиз, а тестировщики видели риск в нестабильных API проверках. Я взял на себя анализ падений, предложил отделить smoke от полного regression и договорился сначала стабилизировать критичные сценарии. В результате релиз не блокировали, а спорные проверки вынесли в отдельный план.',
      analysis,
    );

    const missing = evaluation.missingPoints.join(' ');
    expect(missing).not.toMatch(/Teamwork|Conflict|Ownership|Real example|Result/i);
    expect(evaluation.goodPoints.join(' ')).toMatch(/Teamwork|Conflict|Ownership|Real example/i);
    expect(evaluation.betterStructure?.join(' ')).toMatch(/Situation|Task|Action|Result/);
    expect(evaluation.suggestedBetterAnswer).toMatch(/^Одна из сложных ситуаций была на проекте/i);
    expect(evaluation.suggestedBetterAnswer).not.toMatch(
      /По теме behavioral questions|Я бы начал|Потом добавил бы|Нужно закрыть/i,
    );
  });
  it('never returns coaching notes as the stronger answer in generic fallback', () => {
    const analysis: VacancyAnalysis = {
      id: 'generic-ready-answer',
      vacancyText: 'QA role: test strategy, risk analysis, prioritization.',
      targetRole: 'QA Engineer',
      seniorityLevel: 'middle',
      language: 'ru',
      extractedRequirements: ['test strategy', 'risk analysis'],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'strategy',
          title: 'Test strategy',
          category: 'QA',
          importance: 'medium',
          level: 'middle',
          expectedKnowledge: 'Risk-based test planning.',
          expectedAnswerPoints: ['risk analysis', 'prioritization'],
          sampleQuestions: ['Как вы подходите к тестовой стратегии на новом проекте?'],
          vacancyEvidence: 'test strategy',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'QA experience with regression planning and test documentation.',
      createdAt: Date.now(),
    };
    const [question] = buildSmokePlan(analysis);

    const evaluation = evaluateAnswerMock(
      question,
      'Я сначала смотрю риски продукта, критичные пользовательские сценарии и ограничения по срокам. Потом выделяю smoke и regression зоны.',
      analysis,
    );

    expect(evaluation.suggestedBetterAnswer).not.toMatch(
      /я отвечаю через практический пример|сначала коротко|потом объясняю|отдельно раскрываю|где применял/i,
    );
    expect(evaluation.suggestedBetterAnswer).toMatch(/^Я /i);
  });
});

describe('smoke plan', () => {
  it('builds 8–15 questions grouped by topic, increasing difficulty', async () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const plan = buildSmokePlan(analysis);
    expect(plan.length).toBeGreaterThanOrEqual(8);
    expect(plan.length).toBeLessThanOrEqual(15);
    expect(plan[0].difficulty).toBe('easy');
    expect(plan[plan.length - 1].difficulty).toBe('hard');
    expect(plan.every((q) => analysis.interviewTopics.some((t) => t.id === q.topicId))).toBe(true);
  });
});

describe('evaluation + report', () => {
  it('scores a concrete answer higher than a vague one', async () => {
    const analysis = analyzeVacancyMock({
      vacancyText: QA_VACANCY,
      language: 'ru',
      resumeText: 'Python, Playwright, Docker, GitLab CI на проекте',
    });
    const plan = buildSmokePlan(analysis);
    const q = plan[0];
    const good = evaluateAnswerMock(
      q,
      'На проекте я настраивал запуск pytest в GitLab CI внутри Docker, артефакты и Allure-отчёты, разбирал падения по логам.',
      analysis,
    );
    const vague = evaluateAnswerMock(q, 'Ну, наверное, что-то делал, не знаю точно.', analysis);
    expect(good.score).toBeGreaterThan(vague.score);
  });

  it('flags overclaiming when there is no resume', async () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const plan = buildSmokePlan(analysis);
    const evalRes = evaluateAnswerMock(
      plan[0],
      'У меня огромный опыт, я постоянно настраивал всё в продакшене.',
      analysis,
    );
    expect(evalRes.overclaimed).toBe(true);
  });

  it('builds a readiness report with overall + topic scores', async () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const questions = buildSmokePlan(analysis);
    const session: SmokeReviewSession = {
      id: 's1',
      vacancyAnalysisId: analysis.id,
      vacancyAnalysis: analysis,
      status: 'in_progress',
      questions,
      currentIndex: questions.length - 1,
      startedAt: Date.now(),
      answers: questions.map((q) => ({
        questionId: q.id,
        text: 'На проекте я использовал pytest, Playwright, Docker и Allure, разбирал падения.',
        source: 'text' as const,
        skipped: false,
        evaluation: evaluateAnswerMock(q, 'pytest Playwright Docker Allure на проекте', analysis),
        answeredAt: Date.now(),
      })),
    };
    const report = buildReadinessReport(session);
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);
    expect(report.topicScores.length).toBeGreaterThan(0);
    expect(report.topicScores.every((t) => t.questionsAsked > 0)).toBe(true);
  });

  it('falls back to local evaluation when backend answer review times out', async () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const [question] = buildSmokePlan(analysis);
    const spy = vi
      .spyOn(api, 'vacancyEvaluate')
      .mockRejectedValueOnce(new Error('Операция заняла слишком много времени — попробуйте ещё раз'));

    try {
      const evaluation = await evaluateAnswer(
        question,
        'Я использовал pytest, Playwright, HTTPX, GitLab CI, Docker и Allure на проекте.',
        analysis,
      );

      expect(spy).toHaveBeenCalledOnce();
      expect(evaluation.feedback).toBeTruthy();
      expect(evaluation.suggestedBetterAnswer).toMatch(/^Я |^Кроме|^С flaky|^Для /);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the answer logic, rationale, and delivery coaching from AI feedback', async () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const [question] = buildSmokePlan(analysis);
    const spy = vi.spyOn(api, 'vacancyEvaluate').mockResolvedValueOnce({
      score: 82,
      clarityScore: 80,
      technicalAccuracyScore: 84,
      specificityScore: 76,
      confidenceScore: 81,
      feedback: 'Содержание верное; усили ответ причинно-следственной логикой.',
      goodPoints: ['Есть практические инструменты'],
      missingPoints: [],
      suggestedBetterAnswer: 'Я начинаю с причины, затем показываю проверку и результат.',
      answerStrategy: 'Тезис → диагностика → решение → проверяемый результат.',
      whyThisAnswerWorks: ['Сразу отвечает на вопрос', 'Показывает ход инженерного решения'],
      deliveryTips: ['Сделать короткую паузу после главного тезиса.'],
      overclaimed: false,
    });

    try {
      const evaluation = await evaluateAnswer(
        question,
        'Использовал Playwright, логи и Allure, чтобы разбирать падения.',
        analysis,
      );

      expect(evaluation.answerStrategy).toContain('Тезис');
      expect(evaluation.whyThisAnswerWorks).toHaveLength(2);
      expect(evaluation.deliveryTips).toEqual([
        'Сделать короткую паузу после главного тезиса.',
      ]);
      expect(evaluation.evaluationSource).toBe('ai');
    } finally {
      spy.mockRestore();
    }
  });

  it('sends the raw recognized answer to evaluation with outer trim only', async () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const [question] = buildSmokePlan(analysis);
    const spy = vi.spyOn(api, 'vacancyEvaluate').mockRejectedValueOnce(new Error('offline'));
    const rawAnswer = '  Микрофон не работает. Проверяю JSON  и  headers.  ';

    try {
      await evaluateAnswer(question, rawAnswer, analysis);

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          answer: 'Микрофон не работает. Проверяю JSON  и  headers.',
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('does not turn tool-choice expected knowledge into filler missing words', () => {
    const analysis: VacancyAnalysis = {
      id: 'tool-choice',
      vacancyText: 'Lead QA Automation: Python, API testing, Playwright, Allure, GitLab CI.',
      targetRole: 'Lead QA Automation Engineer',
      seniorityLevel: 'lead',
      language: 'ru',
      extractedRequirements: ['API testing', 'Playwright', 'Allure', 'GitLab CI'],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'automation-strategy',
          title: 'Стратегии автоматизированного тестирования',
          category: 'Testing',
          importance: 'high',
          level: 'lead',
          expectedKnowledge:
            'Кандидат должен объяснить, как формировать и развивать стратегию автоматизированного тестирования.',
          sampleQuestions: ['Какие факторы вы учитываете при выборе инструментов для автоматизации?'],
          vacancyEvidence: 'API testing, Playwright, Allure, GitLab CI',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'Python, Requests, HTTPX, Playwright, Allure, GitLab CI.',
      createdAt: Date.now(),
    };
    const [question] = buildSmokePlan(analysis);

    expect(question.expectedSignals).not.toEqual(
      expect.arrayContaining(['Кандидат', 'должен', 'объяснить', 'формировать', 'развивать']),
    );

    const evaluation = evaluateAnswerMock(
      question,
      'Инструменты уже были выбраны, но для API я использовал Requests и HTTPX, для UI — Playwright, для отчетов — Allure, а запуск был в GitLab CI.',
      analysis,
    );

    expect(evaluation.technicalAccuracyScore).toBeGreaterThanOrEqual(50);
    expect(evaluation.missingPoints).not.toEqual(
      expect.arrayContaining(['Кандидат', 'должен', 'объяснить']),
    );
    expect(evaluation.verdict ?? '').not.toContain('Lead-уровня');
    expect(evaluation.suggestedBetterAnswer).not.toContain('Прямо отвечаю');
    expect(evaluation.suggestedBetterAnswer).not.toContain('Кандидат');
    expect(evaluation.suggestedBetterAnswer).toContain('Requests');
    expect(evaluation.suggestedBetterAnswer).toContain('Playwright');
    expect(evaluation.suggestedBetterAnswer).toContain('GitLab CI');
  });

  it('handles autotest platform support answers without filler signals', () => {
    const analysis: VacancyAnalysis = {
      id: 'platform-support',
      vacancyText:
        'Lead QA Automation: поддержка автотестовой платформы, Playwright, API testing, pytest, Allure, GitLab CI.',
      targetRole: 'Lead QA Automation Engineer',
      seniorityLevel: 'lead',
      language: 'ru',
      extractedRequirements: ['Playwright', 'API testing', 'pytest', 'Allure', 'GitLab CI'],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'autotest-platform',
          title: 'Автотестовая платформа и её поддержка',
          category: 'Testing',
          importance: 'high',
          level: 'lead',
          expectedKnowledge:
            'Кандидат должен объяснить, как поддерживать и развивать автотестовую платформу.',
          expectedAnswerPoints: [
            'Кандидат должен объяснить поддержку и развитие платформы',
            'UI/API инструменты',
            'параллельные запуски',
            'отчётность и CI/CD',
          ],
          sampleQuestions: ['Какие инструменты вы использовали для поддержки автотестовой платформы?'],
          vacancyEvidence: 'поддержка автотестовой платформы, Playwright, API testing, pytest, Allure',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'Playwright, Selenium, Requests, HTTPX, pytest-xdist, Pydantic, Allure, GitLab CI.',
      createdAt: Date.now(),
    };
    const [question] = buildSmokePlan(analysis);

    expect(question.expectedSignals.join(' ')).not.toMatch(/Кандидат|должен|объяснить|развивать/);

    const evaluation = evaluateAnswerMock(
      question,
      'Для UI-автотестирования использовал Playwright, раньше Selenium. Для API — Request и HTTPX, для параллельных запусков xDisk, ещё Pydentic. Для отчётов использовал Allure. Это будет в этом видео.',
      analysis,
    );

    expect(evaluation.technicalAccuracyScore).toBeGreaterThanOrEqual(60);
    expect(evaluation.missingPoints.join(' ')).not.toMatch(/Кандидат|должен|объяснить|развивать/);
    expect(evaluation.followUpQuestions?.join(' ') ?? '').not.toMatch(/Кандидат|должен|объяснить/);
    expect(evaluation.nextTrainingFocus ?? '').not.toMatch(/Кандидат|должен|объяснить/);
    expect(evaluation.detectedNoiseOrAsrErrors?.join(' ') ?? '').toMatch(/видео/);
    expect(evaluation.suggestedBetterAnswer).not.toContain('Я бы начал');
    expect(evaluation.suggestedBetterAnswer).toContain('Playwright');
    expect(evaluation.suggestedBetterAnswer).toContain('HTTPX');
    expect(evaluation.suggestedBetterAnswer).toContain('Allure');
  });

  it('matches expected points semantically and does not mark covered points as missing', () => {
    const analysis: VacancyAnalysis = {
      id: 'semantic-api',
      vacancyText: 'QA Automation: API testing, Playwright, GitLab CI, Allure.',
      targetRole: 'QA Automation Engineer',
      seniorityLevel: 'middle',
      language: 'ru',
      extractedRequirements: ['API testing', 'Playwright', 'GitLab CI', 'Allure'],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'api-checks',
          title: 'API testing',
          category: 'Testing',
          importance: 'high',
          level: 'middle',
          expectedKnowledge: 'API response validation beyond status 200.',
          expectedAnswerPoints: [
            'schema/body checks',
            'auth',
            'negative cases',
            'state verification',
          ],
          sampleQuestions: ['Что проверяете в API кроме статус-кода 200?'],
          vacancyEvidence: 'API testing',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'API tests with pytest, HTTPX, Pydantic models, auth checks.',
      createdAt: Date.now(),
    };
    const [question] = buildSmokePlan(analysis);

    const evaluation = evaluateAnswerMock(
      question,
      'Кроме 200 я проверяю схему ответа через Pydantic, типы полей, обязательные поля, headers, token и права доступа. По негативным кейсам смотрю 400, 401, 403 и ошибки валидации.',
      analysis,
    );

    expect(evaluation.technicalAccuracyScore).toBeGreaterThan(0);
    expect(evaluation.missingPoints.join(' ')).not.toMatch(/schema\/body|auth|negative/i);
    expect(evaluation.goodPoints.join(' ')).toMatch(/schema|auth|negative|API/i);
    expect(evaluation.suggestedBetterAnswer).not.toMatch(/Я бы начал|Потом добавил бы|Нужно закрыть/i);
  });

  it('treats waits and Git conflict resolution as semantic partial coverage', () => {
    const uiAnalysis: VacancyAnalysis = {
      id: 'semantic-ui',
      vacancyText: 'QA Automation: Playwright, flaky tests.',
      targetRole: 'QA Automation Engineer',
      seniorityLevel: 'middle',
      language: 'ru',
      extractedRequirements: ['Playwright', 'flaky tests'],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'flaky-ui',
          title: 'Flaky UI tests',
          category: 'Testing',
          importance: 'high',
          level: 'middle',
          expectedKnowledge: 'How to stabilize UI tests.',
          expectedAnswerPoints: ['waits', 'locators', 'failure analysis'],
          sampleQuestions: ['Как боретесь с flaky UI-тестами?'],
          vacancyEvidence: 'Playwright, flaky tests',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'Playwright, Allure, screenshots, logs.',
      createdAt: Date.now(),
    };
    const [uiQuestion] = buildSmokePlan(uiAnalysis);
    const uiEval = evaluateAnswerMock(
      uiQuestion,
      'Я убираю sleep и добавляю явные ожидания состояния элемента, смотрю Allure, скриншоты и логи падения.',
      uiAnalysis,
    );
    expect(uiEval.missingPoints).not.toContain('waits');
    expect(uiEval.technicalAccuracyScore).toBeGreaterThan(0);

    const gitAnalysis: VacancyAnalysis = {
      id: 'semantic-git',
      vacancyText: 'QA Automation: Git, merge, rebase.',
      targetRole: 'QA Automation Engineer',
      seniorityLevel: 'middle',
      language: 'ru',
      extractedRequirements: ['Git'],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'git',
          title: 'Git merge vs rebase',
          category: 'Tools',
          importance: 'medium',
          level: 'middle',
          expectedKnowledge: 'Merge, rebase, conflict resolution.',
          expectedAnswerPoints: ['merge', 'rebase', 'conflict resolution'],
          sampleQuestions: ['Чем merge отличается от rebase?'],
          vacancyEvidence: 'Git',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'Git, feature branches, merge requests.',
      createdAt: Date.now(),
    };
    const [gitQuestion] = buildSmokePlan(gitAnalysis);
    const gitEval = evaluateAnswerMock(
      gitQuestion,
      'Merge объединяет ветки, rebase обновляет feature branch поверх develop. Если был мерч-конфликт, я разбирал его в IDE или через консоль и потом прогонял тесты.',
      gitAnalysis,
    );
    expect(gitEval.missingPoints).not.toContain('conflict resolution');
    expect(gitEval.technicalAccuracyScore).toBeGreaterThan(0);
    expect(gitEval.suggestedBetterAnswer).not.toMatch(/Я бы начал|Потом добавил бы|Нужно закрыть/i);
    // Regression: a topic whose expectedKnowledge mentions "conflict resolution"
    // must still get the actual git explanation, not the behavioral conflict-story
    // opening (topic.expectedKnowledge must not leak into question classification).
    expect(gitEval.suggestedBetterAnswer).toMatch(/merge|rebase/i);
    expect(gitEval.suggestedBetterAnswer).not.toContain('Одна из сложных ситуаций');
  });

  it('does not rewrite garbled technical terms with an STT dictionary', () => {
    const analysis: VacancyAnalysis = {
      id: 'asr-normalization',
      vacancyText: 'QA Automation: Playwright, UI tests, Allure.',
      targetRole: 'QA Automation Engineer',
      seniorityLevel: 'middle',
      language: 'ru',
      extractedRequirements: ['Playwright', 'Allure'],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'flaky-ui-asr',
          title: 'Flaky UI tests',
          category: 'Testing',
          importance: 'high',
          level: 'middle',
          expectedKnowledge: 'Locators, waits, page objects, flaky-test handling.',
          expectedAnswerPoints: ['Locators', 'waits', 'page objects', 'flaky-test handling'],
          sampleQuestions: ['Как борешься с flaky UI-тестами?'],
          vacancyEvidence: 'Playwright, UI tests',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'Playwright, Allure, screenshots, logs.',
      createdAt: Date.now(),
    };
    const [question] = buildSmokePlan(analysis);

    // Real Whisper output: "филокит" = flaky, "Альурочотов" = Allure отчётов,
    // "ДИВ" = diff, "Xpef" = expected.
    const evaluation = evaluateAnswerMock(
      question,
      'Для того, чтобы бороться с филокит-тестами, обычно я использую надежные локаторы. Для флага тестов явные ожидания. использовать правильно инструменты логирования. Альурочотов присутствует, ДИВ скриншоты и скриншоты ожидаемые, Xpef, и скриншоты актуальны.',
      analysis,
    );

    // The removed correction dictionary must not create a rewritten transcript.
    expect(evaluation.normalizedAnswerSummary).toBeUndefined();
    expect(evaluation.detectedNoiseOrAsrErrors).toBeUndefined();
  });

  it('gives a Playwright-vs-Selenium answer, not the flaky-UI answer, for that specific question', () => {
    // Regression test: this topic has TWO distinct sample questions sharing one
    // expectedKnowledge ("...flaky-test handling"), which used to make every
    // question under it get the flaky-test-debugging answer regardless of what
    // was actually asked.
    const analysis: VacancyAnalysis = {
      id: 'ui-automation-two-questions',
      vacancyText: 'QA Automation: Playwright, Selenium, UI tests.',
      targetRole: 'QA Automation Engineer',
      seniorityLevel: 'middle',
      language: 'ru',
      extractedRequirements: ['Playwright', 'Selenium'],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'ui-automation',
          title: 'UI automation (Playwright / Selenium)',
          category: 'Testing',
          importance: 'high',
          level: 'middle',
          expectedKnowledge: 'Locators, waits, page objects, flaky-test handling.',
          expectedAnswerPoints: ['Locators', 'waits', 'page objects', 'flaky-test handling'],
          sampleQuestions: [
            'Как борешься с flaky UI-тестами?',
            'Чем Playwright удобнее Selenium на динамических интерфейсах?',
          ],
          vacancyEvidence: 'Playwright, Selenium, UI tests',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'Playwright, Selenium, Allure.',
      createdAt: Date.now(),
    };
    const questions = buildSmokePlan(analysis);
    const pwQuestion = questions.find((q) => q.question.includes('удобнее Selenium'));
    expect(pwQuestion).toBeDefined();

    const evaluation = evaluateAnswerMock(
      pwQuestion!,
      'Playwright удобнее, потому что есть встроенные ожидания и встроенные ассерты на ошибки. Также удобно ставить на паузу запуск приложения для дебага.',
      analysis,
    );

    expect(evaluation.suggestedBetterAnswer).toMatch(/playwright/i);
    expect(evaluation.suggestedBetterAnswer).toMatch(/selenium/i);
    expect(evaluation.suggestedBetterAnswer).not.toContain('С flaky UI-тестами я сначала разбираю причину');
    // Expected signals must be tailored to THIS question, not the topic's
    // generic (and here, unrelated) flaky-test-handling signal list.
    expect(evaluation.missingPoints.join(' ')).not.toContain('page objects');
  });

  it('classifies "tell me about your project" as a project story, not a conflict story', () => {
    const analysis: VacancyAnalysis = {
      id: 'project-experience',
      vacancyText: 'QA Automation Engineer role.',
      targetRole: 'QA Automation Engineer',
      seniorityLevel: 'middle',
      language: 'ru',
      extractedRequirements: [],
      optionalSkills: [],
      interviewTopics: [
        {
          id: 'project-experience',
          title: 'Project experience',
          category: 'Experience',
          importance: 'high',
          level: 'middle',
          expectedKnowledge: 'Concrete real projects: role, stack, impact, ownership.',
          sampleQuestions: ['Расскажи про свой самый показательный проект и твою роль в нём.'],
          vacancyEvidence: 'Any real interview checks project experience.',
        },
      ],
      projectQuestions: [],
      riskAreas: [],
      hasResume: true,
      hasLegend: false,
      resumeText: 'Playwright, pytest, Allure.',
      createdAt: Date.now(),
    };
    const [question] = buildSmokePlan(analysis);
    const evaluation = evaluateAnswerMock(
      question,
      'Работал над платформой автотестов на Playwright и pytest, сам выбирал, что автоматизировать.',
      analysis,
    );

    expect(evaluation.suggestedBetterAnswer).toContain('Самый показательный проект');
    expect(evaluation.suggestedBetterAnswer).not.toContain('Одна из сложных ситуаций');
  });
});

describe('interviewer drill-down (дожим)', () => {
  it('builds a follow-up question on the same topic with missing points as signals', () => {
    const analysis = analyzeVacancyMock({
      vacancyText: QA_VACANCY,
      language: 'ru',
      resumeText: 'Python, Playwright, Docker, GitLab CI на проекте',
    });
    const [parent] = buildSmokePlan(analysis);
    const evaluation = evaluateAnswerMock(parent, 'Ну, использовал какие-то инструменты.', analysis);

    const drill = buildDrillDownQuestion(parent, 'А как именно вы запускали это в CI?', evaluation);

    expect(drill.id).not.toBe(parent.id);
    expect(drill.topicId).toBe(parent.topicId);
    expect(drill.isFollowUp).toBe(true);
    expect(drill.parentQuestionId).toBe(parent.id);
    expect(drill.question).toBe('А как именно вы запускали это в CI?');
    // Дожим проверяет именно пробел: сигналы — то, чего не хватило в ответе.
    if (evaluation.missingPoints.length) {
      expect(drill.expectedSignals).toEqual(evaluation.missingPoints.slice(0, 5));
    } else {
      expect(drill.expectedSignals).toEqual(parent.expectedSignals);
    }
  });

  it('falls back to parent signals when the evaluation has no missing points', () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const [parent] = buildSmokePlan(analysis);
    const drill = buildDrillDownQuestion(parent, 'Уточните пример.', undefined);
    expect(drill.expectedSignals).toEqual(parent.expectedSignals);
    expect(drill.expectedAnswerPoints).toBeUndefined();
  });

  it('caps drill chains at MAX_DRILL_DEPTH like a real interviewer', () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const [root] = buildSmokePlan(analysis);
    const d1 = buildDrillDownQuestion(root, 'А подробнее?');
    const d2 = buildDrillDownQuestion(d1, 'А ещё подробнее?');
    const questions = [root, d1, d2];

    expect(drillDepth(root, questions)).toBe(0);
    expect(drillDepth(d1, questions)).toBe(1);
    expect(drillDepth(d2, questions)).toBe(2);
    // На d2 дожим уже недоступен: глубина достигла потолка.
    expect(drillDepth(d2, questions)).toBeGreaterThanOrEqual(MAX_DRILL_DEPTH);
  });

  it('drill-down answers aggregate into the same topic in the report', () => {
    const analysis = analyzeVacancyMock({ vacancyText: QA_VACANCY, language: 'ru' });
    const questions = buildSmokePlan(analysis).slice(0, 1);
    const [parent] = questions;
    const parentEval = evaluateAnswerMock(parent, 'Использовал pytest на проекте.', analysis);
    const drill = buildDrillDownQuestion(parent, 'А как именно?', parentEval);
    const withDrill = [...questions, drill];
    const session: SmokeReviewSession = {
      id: 's-drill',
      vacancyAnalysisId: analysis.id,
      vacancyAnalysis: analysis,
      status: 'in_progress',
      questions: withDrill,
      currentIndex: 1,
      startedAt: Date.now(),
      answers: withDrill.map((q) => ({
        questionId: q.id,
        text: 'pytest, Playwright, Docker и Allure на проекте',
        source: 'text' as const,
        skipped: false,
        evaluation: evaluateAnswerMock(q, 'pytest Playwright Docker Allure на проекте', analysis),
        answeredAt: Date.now(),
      })),
    };
    const report = buildReadinessReport(session);
    const topicScore = report.topicScores.find((t) => t.topicId === parent.topicId);
    expect(topicScore).toBeDefined();
    expect(topicScore!.questionsAsked).toBe(2); // родитель + дожим в одной теме
  });
});

describe('readiness thresholds', () => {
  it('maps scores to statuses/labels', () => {
    expect(topicStatusFromScore(80)).toBe('strong');
    expect(topicStatusFromScore(60)).toBe('medium');
    expect(topicStatusFromScore(40)).toBe('weak');
    expect(topicStatusFromScore(10)).toBe('critical');
    expect(readinessLabelFromScore(90)).toBe('strong');
    expect(readinessLabelFromScore(72)).toBe('ready');
    expect(readinessLabelFromScore(55)).toBe('almost_ready');
    expect(readinessLabelFromScore(35)).toBe('weak');
    expect(readinessLabelFromScore(10)).toBe('not_ready');
  });

  it('uses amber, not dull blue, for partial readiness states', () => {
    expect(readinessTone('almost_ready')).toBe('amber');
    expect(topicStatusTone('medium')).toBe('amber');
  });
});
