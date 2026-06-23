/**
 * Исправляет ошибки STT: только подмена слов, без подмены всего вопроса.
 */

const RULES: { from: string; to: string }[] = [
  { from: 'эй кью эй', to: 'AQA' },
  { from: 'обеспечение качества', to: 'QA' },
  { from: 'аэроэстопе', to: 'REST API' },
  { from: 'аэро стопе', to: 'REST API' },
  { from: 'рест апи', to: 'REST API' },
  { from: 'рест api', to: 'REST API' },
  { from: 'гитлаб си ай', to: 'GitLab CI' },
  { from: 'си ай си ди', to: 'CI/CD' },
  { from: 'о о п', to: 'ООП' },
  { from: 'кью эй', to: 'QA' },
  { from: 'пайтест', to: 'pytest' },
  { from: 'пай тест', to: 'pytest' },
  { from: 'плейврайт', to: 'Playwright' },
  { from: 'селениум', to: 'Selenium' },
  { from: 'постгрес', to: 'PostgreSQL' },
  { from: 'сваггер', to: 'Swagger' },
  { from: 'постман', to: 'Postman' },
  { from: 'джира', to: 'Jira' },
  { from: 'докер', to: 'Docker' },
  { from: 'кубернетес', to: 'Kubernetes' },
  { from: 'греп', to: 'grep' },
];

const FUZZY: { re: RegExp; to: string }[] = [
  { re: /тест\s*[-\s]?дизайн\w*/giu, to: 'тест-дизайна' },
  { re: /паттерн\w*\s+по\s+тест\w*/giu, to: 'паттерны pytest' },
  { re: /по\s+тест(?:у|ам|е)\b/giu, to: 'pytest' },
  { re: /п(?:ai|ай|аи)\s*[-\s]?test/giu, to: 'pytest' },
  { re: /благодаря\s+какой\s+команд\w*/giu, to: 'с помощью какой команды' },
  { re: /какой\s+команд\w*\s+можно\s+искать/giu, to: 'с помощью какой команды можно искать' },
  { re: /\bлин(?:укс|уксе|уз|uxe|uks|зе|за|zе)\w*\b/giu, to: 'Linux' },
  { re: /\b(?:g\s*r\s*e\s*p|г\s*р\s*э\s*п)\b/giu, to: 'grep' },
  { re: /так(?:ие|ой)\s*(?:2|два)\s*принцип/giu, to: 'какие принципы' },
  { re: /принцип\w*\s+(?:ал+[оo]п\w*|о+[лl]оп\w*)/giu, to: 'принципы ООП' },
  { re: /принцип\w*\s+о\s+(?:[ло]{3,}\w*)+/giu, to: 'принципы ООП' },
  { re: /(?<=принцип\w*\s+)ал+[оo]п\w*/giu, to: 'ООП' },
  { re: /т(?:ы|и|е|а)\s*ст[ёеe]рг\w*/giu, to: 'тестирования' },
  { re: /ст[ёеe]рг\w*/giu, to: 'тестирования' },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const compiled = RULES.map((rule) => ({
  re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(rule.from)}(?![\\p{L}\\p{N}])`, 'giu'),
  to: rule.to,
}));

const ABBREV: { re: RegExp; to: string }[] = [
  { re: /\b(?:э|е|а)?р\s*э\s*эс\s*т(?:и|e)?\b/giu, to: 'REST' },
  { re: /\br\s*s\s*t\b/giu, to: 'REST' },
  { re: /\bрест\b/giu, to: 'REST' },
  { re: /\b(?:апи|a p i)\b/giu, to: 'API' },
  { re: /\bо\s*о\s*п\b/giu, to: 'ООП' },
];

/** Убирает только хвостовые шаблонные фразы LLM, не тело ответа про опыт. */
export function stripExperienceFooter(text: string): string {
  let out = text.trim();
  const cutPatterns = [
    /\n?\s*Если нужно, могу[\s\S]*$/iu,
    /\n?\s*Могу также рассказать[\s\S]*$/iu,
    /\n?\s*Хотите, чтобы я[\s\S]*$/iu,
  ];
  for (const re of cutPatterns) {
    out = out.replace(re, '');
  }
  return out.trim();
}

export function normalizeTranscript(rawText: string): string {
  let result = rawText.trim();
  for (const { re, to } of compiled) {
    result = result.replace(re, to);
  }
  for (const { re, to } of FUZZY) {
    result = result.replace(re, to);
  }
  for (const { re, to } of ABBREV) {
    result = result.replace(re, to);
  }
  if (/\bREST\b/i.test(result) && /api|апи/i.test(result) && !/REST API/i.test(result)) {
    result = result.replace(/\bREST\b/gi, 'REST API');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

export function mergeQuestionParts(parts: string[]): string {
  const cleaned = parts.map((p) => p.trim()).filter((p) => p.length > 2);
  if (cleaned.length === 0) return '';
  return normalizeTranscript(cleaned.join(' '));
}

export function mergeRawParts(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 2)
    .join(' ');
}

export function questionChanged(prev: string, next: string): boolean {
  const a = prev.toLowerCase().replace(/\s+/g, ' ').trim();
  const b = next.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!a || !b) return true;
  if (a === b) return false;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.includes(shorter) && shorter.length / longer.length > 0.65) return false;
  return true;
}

export function looksLikeQuestion(text: string): boolean {
  const t = normalizeTranscript(text.trim());
  if (t.length < 8) return false;
  return /[?]|^(как|что|какие|какой|какая|какую|расскаж|опиш|назов|перечисл|чем|можно|благодаря|с\s+помощью|зачем|почему|где|когда|паттерн)/iu.test(
    t,
  );
}
