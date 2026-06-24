import type { AnswerStrategyResult } from './classifyInterviewQuestionIntent';

const BUG_COUNT_RE =
  /(?:много\s+баг|сколько\s+баг|находил[\p{L}]*\s+(?:ли\s+)?(?:ваши\s+)?автотест[\p{L}]*\s+баг|находил[\p{L}]*\s+баг)/iu;

const TEAM_SIZE_RE = /(?:сколько\s+автоматизатор|сколько\s+.+\s+в\s+команд|состав\s+команд)/iu;

const KAFKA_DEEP_RE = /(?:глубок[\p{L}]+.*kafka|kafka.*глубок|ты\s+глубок[\p{L}]+.*kafka)/iu;

const ALL_600_RE = /(?:все\s+600|сам\s+написал[\p{L}]*\s+.{0,25}600|написал[\p{L}]*\s+все\s+(?:авто)?тест)/iu;

const REST_ASSURED_RE = /(?:rest\s*assured|restassured)/iu;

const CRITICAL_BUG_RE = /(?:критичн[\p{L}]+\s+баг|баг\s+перед\s+релиз)/iu;

const SELENIUM_PLAYWRIGHT_RE = /(?:selenium.{0,30}playwright|playwright.{0,30}selenium|чем\s+отлича.{0,20}selenium)/iu;

/** Overrides answer strategy for questions that need conservative, fact-safe responses. */
export function getDangerQuestionStrategy(question: string): Partial<AnswerStrategyResult> | null {
  const q = question.trim();
  if (!q) return null;

  if (BUG_COUNT_RE.test(q)) {
    return {
      answerStrategy:
        'Do NOT invent bug counts or say «много багов» without metrics. Say exact numbers were not tracked. ' +
        'Focus: regressions in critical UI/API/data/visual scenarios; smoke in CI/CD; screenshot checks. 4–6 sentences.',
      resumeContextUsed: true,
      resumeContextLevel: 'limited',
      resumeContextReason: 'Bug-count question — no invented metrics.',
    };
  }

  if (TEAM_SIZE_RE.test(q)) {
    return {
      answerStrategy:
        'Do NOT invent team size. If resume has exact number — use it. Otherwise: team varied by period/project; ' +
        'Geomix AQA + second AQA on screenshot framework; interact with devs/analysts/QA; no exact headcount. 4–5 sentences.',
      resumeContextUsed: true,
      resumeContextLevel: 'limited',
      resumeContextReason: 'Team-size question — no invented numbers.',
    };
  }

  if (KAFKA_DEEP_RE.test(q)) {
    return {
      answerStrategy:
        'Answer conservatively: no deep Kafka admin/production unless in resume. ' +
        'Say checks/logs/understanding level if applicable. Do NOT invent Kafka infrastructure experience. 3–5 sentences.',
      resumeContextUsed: true,
      resumeContextLevel: 'limited',
      resumeContextReason: 'Kafka depth question — conservative resume use.',
    };
  }

  if (ALL_600_RE.test(q)) {
    return {
      answerStrategy:
        'Deny authorship of all 600 tests. Say «активный smoke-набор ~600 автотестов» in Sber context; ' +
        'maintained/developed/stabilized — NOT wrote entire suite from scratch. 3–4 sentences.',
      resumeContextUsed: true,
      resumeContextLevel: 'full',
      resumeContextReason: '600-tests authorship — strict resume fact.',
    };
  }

  if (REST_ASSURED_RE.test(q)) {
    return {
      answerStrategy:
        'Say no RestAssured — Python stack: HTTPX/Requests + Pytest. Do not invent Java tools. 2–4 sentences.',
      resumeContextUsed: true,
      resumeContextLevel: 'limited',
      resumeContextReason: 'RestAssured — not in stack.',
    };
  }

  if (CRITICAL_BUG_RE.test(q)) {
    return {
      answerStrategy:
        'Focus on release risk process: impact, workaround, users affected, rollback. ' +
        'Do NOT inject unrelated tools (Playwright etc.) unless question asks. No invented bug stories. 4–6 sentences.',
      resumeContextUsed: false,
      resumeContextLevel: 'none',
      resumeContextReason: 'Critical bug before release — process answer, not tool dump.',
    };
  }

  if (SELENIUM_PLAYWRIGHT_RE.test(q)) {
    return {
      answerStrategy:
        'Compare Selenium vs Playwright: maturity/multi-browser vs modern waits/context/trace/network for UI tests. ' +
        'Do NOT say network interception replaces API tests. Mention Playwright preference for new UI tests; ' +
        'keep existing Selenium base if large. 4–6 sentences.',
      resumeContextUsed: true,
      resumeContextLevel: 'limited',
      resumeContextReason: 'Selenium vs Playwright comparison.',
    };
  }

  return null;
}
