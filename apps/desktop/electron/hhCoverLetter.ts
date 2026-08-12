export interface HhCoverLetterRequest {
  vacancyTitle: string;
  vacancyCompany: string;
  vacancyDescription: string;
  resumeText?: string;
  language: 'ru' | 'en';
}

export interface HhCoverLetterMatch {
  vacancyNeed: string;
  resumeEvidence: string;
}

export interface HhCoverLetterResponse {
  coverLetter: string;
  matches: HhCoverLetterMatch[];
  canAutoFill: boolean;
  reason?: string;
  model?: string;
}

export interface ValidatedHhCoverLetter {
  letter: string;
  matches: HhCoverLetterMatch[];
}

interface GroundedCapability {
  label: string;
  vacancyNeed: string;
  resumeEvidence: string;
  patterns: RegExp[];
}

const GROUNDED_CAPABILITIES: GroundedCapability[] = [
  {
    label: 'Python',
    vacancyNeed: 'Python',
    resumeEvidence: 'В резюме указан практический опыт работы с Python.',
    patterns: [/\bpython\b/iu],
  },
  {
    label: 'Pytest',
    vacancyNeed: 'Pytest',
    resumeEvidence: 'В резюме указан опыт разработки и поддержки тестов на Pytest.',
    patterns: [/\bpytest\b/iu],
  },
  {
    label: 'Playwright',
    vacancyNeed: 'Playwright',
    resumeEvidence: 'В резюме указан опыт автоматизации с Playwright.',
    patterns: [/\bplaywright\b/iu],
  },
  {
    label: 'Selenium',
    vacancyNeed: 'Selenium',
    resumeEvidence: 'В резюме указан опыт UI-автоматизации с Selenium.',
    patterns: [/\bselenium\b/iu],
  },
  {
    label: 'REST API',
    vacancyNeed: 'API-тестирование и REST',
    resumeEvidence: 'В резюме указан опыт тестирования API и работы с REST.',
    patterns: [/\brest(?:ful)?\b/iu, /\bapi[-\s]?тест/iu, /тестирован\S*\s+api/iu],
  },
  {
    label: 'Docker',
    vacancyNeed: 'Docker',
    resumeEvidence: 'В резюме указан практический опыт работы с Docker.',
    patterns: [/\bdocker\b/iu],
  },
  {
    label: 'CI/CD',
    vacancyNeed: 'CI/CD',
    resumeEvidence: 'В резюме указан опыт интеграции автотестов в CI/CD.',
    patterns: [/\bci\s*\/\s*cd\b/iu, /\bgitlab\s+ci\b/iu, /\bjenkins\b/iu],
  },
  {
    label: 'Allure',
    vacancyNeed: 'Allure',
    resumeEvidence: 'В резюме указан опыт работы с отчётами Allure.',
    patterns: [/\ballure\b/iu],
  },
  {
    label: 'SQL',
    vacancyNeed: 'SQL и базы данных',
    resumeEvidence: 'В резюме указан опыт работы с SQL и базами данных.',
    patterns: [/\bsql\b/iu, /\bpostgres(?:ql)?\b/iu],
  },
  {
    label: 'Linux',
    vacancyNeed: 'Linux',
    resumeEvidence: 'В резюме указан практический опыт работы в Linux.',
    patterns: [/\blinux\b/iu],
  },
  {
    label: 'Appium',
    vacancyNeed: 'мобильная автоматизация и Appium',
    resumeEvidence: 'В резюме указан опыт мобильной автоматизации с Appium.',
    patterns: [/\bappium\b/iu],
  },
];

function hasCapability(text: string, capability: GroundedCapability): boolean {
  return capability.patterns.some((pattern) => pattern.test(text));
}

function joinRussian(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} и ${items.at(-1)}`;
}

/**
 * Offline/quota fallback for HH. It deliberately mentions only technologies
 * found both in the full vacancy description and in the selected résumé.
 */
export function buildGroundedLocalHhCoverLetter(
  request: HhCoverLetterRequest,
): HhCoverLetterResponse {
  const vacancy = request.vacancyDescription.toLocaleLowerCase('ru');
  const resume = (request.resumeText ?? '').toLocaleLowerCase('ru');
  const matches = GROUNDED_CAPABILITIES
    .filter((capability) => hasCapability(vacancy, capability) && hasCapability(resume, capability))
    .slice(0, 5);

  if (matches.length < 2) {
    return {
      coverLetter: '',
      matches: [],
      canAutoFill: false,
      reason: 'Не найдено двух подтверждённых совпадений между вакансией и выбранным резюме.',
      model: 'local-grounded-v1',
    };
  }

  const title = request.vacancyTitle.replace(/\s+/g, ' ').trim().slice(0, 180);
  const company = request.vacancyCompany.replace(/\s+/g, ' ').trim().slice(0, 120);
  const skills = joinRussian(matches.map((match) => match.label));
  const role = title ? `«${title}»` : 'в команде автоматизации тестирования';
  const companyText = company ? ` в ${company}` : '';
  const coverLetter = `Здравствуйте!\n\nЗаинтересовала вакансия ${role}${companyText}. По описанию вижу прямое совпадение с моим практическим опытом: ${skills}. Все перечисленные навыки есть в выбранном резюме и одновременно входят в требования этой позиции.\n\nМне близка роль, где автоматизация помогает команде быстрее получать надёжную обратную связь о качестве продукта. Готов предметно обсудить текущий набор автотестов, задачи на развитие тестовой инфраструктуры и ожидания от специалиста на этой позиции. На встрече подробнее расскажу о релевантных проектах, своей зоне ответственности и подходе к поддержке автотестов.\n\nБуду рад знакомству!`;

  return {
    coverLetter,
    matches: matches.map(({ vacancyNeed, resumeEvidence }) => ({
      vacancyNeed,
      resumeEvidence,
    })),
    canAutoFill: true,
    reason: 'Письмо собрано локально только из совпадений вакансии и выбранного резюме.',
    model: 'local-grounded-v1',
  };
}

// A finished cover letter has no template fields at all. Be deliberately
// strict here: square/curly brackets in prose are not worth the risk of
// sending `[Ваше имя]`, `[Company]`, or a similar unfinished token to HH.
const PLACEHOLDER_PATTERN = /\{[^{}\n]{1,120}\}|\[[^[\]\n]{1,120}\]|<(?:your\s+name|name|company|имя|компания)>/iu;
const FORMAL_SIGNOFF_PATTERN = /(?:^|\n)\s*(?:с\s+уважением|уважительно|best\s+regards|kind\s+regards|sincerely|respectfully)(?:\s*[,!.]|\s*$)/imu;
const MARKDOWN_LIST_PATTERN = /^(?:\s*[-*]\s+|\s*\d+[.)]\s+)/mu;

/**
 * Reject weak or unfinished model output before it reaches the HH form. The
 * backend performs the same checks; this is the final desktop-side guard.
 */
export function validateGeneratedHhCoverLetter(
  response: HhCoverLetterResponse,
): ValidatedHhCoverLetter | null {
  if (!response.canAutoFill || !Array.isArray(response.matches) || response.matches.length < 2) {
    return null;
  }
  const letter = String(response.coverLetter ?? '').replace(/\r\n/g, '\n').trim();
  if (letter.length < 350 || letter.length > 4_000) return null;
  if (!/^(?:Здравствуйте!|Hello[!,])/iu.test(letter)) return null;
  if (
    PLACEHOLDER_PATTERN.test(letter)
    || FORMAL_SIGNOFF_PATTERN.test(letter)
    || MARKDOWN_LIST_PATTERN.test(letter)
  ) return null;

  const matches = response.matches
    .filter((item) => item && item.vacancyNeed?.trim() && item.resumeEvidence?.trim())
    .slice(0, 5)
    .map((item) => ({
      vacancyNeed: item.vacancyNeed.trim().slice(0, 300),
      resumeEvidence: item.resumeEvidence.trim().slice(0, 500),
    }));
  if (matches.length < 2) return null;
  return { letter, matches };
}
