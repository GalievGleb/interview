import { QA_QUESTION_BANK } from './qaQuestionBank';
import type { AppliedCorrection, CorrectionConfidence } from './correctTranscriptWithGlossary';

export interface IntentCorrectionInput {
  raw: string;
  corrected: string;
  corrections: AppliedCorrection[];
}

export interface IntentCorrection {
  from: string;
  to: string;
  reason: string;
  confidence: CorrectionConfidence;
}

export interface IntentCorrectionResult {
  raw: string;
  corrected: string;
  intentCorrected: string;
  intentCorrections: IntentCorrection[];
  changed: boolean;
  confidence: CorrectionConfidence | 'none';
  reason?: string;
  ambiguity?: string;
}

const SHORT_QUESTION_MAX = 120;

interface PhraseRule {
  test: (text: string) => boolean;
  intent: string;
  confidence: CorrectionConfidence;
  reason: string;
  ambiguity?: string;
}

const PHRASE_RULES: PhraseRule[] = [
  {
    test: (text) => {
      const l = text.toLowerCase();
      return (
        l.includes('чем') &&
        (l.includes('list') || l.includes('лист') || l.includes('список')) &&
        l.includes('отлича') &&
        (l.includes('tuple') || l.includes('typo') || l.includes('тупл') || l.includes('кортеж'))
      );
    },
    intent: 'Чем list отличается от tuple?',
    confidence: 'high',
    reason: 'ASR: list/лист vs tuple/typo Python comparison',
  },
  {
    test: (text) => {
      const l = text.toLowerCase();
      return l.includes('чем') && l.includes('list') && l.includes('отлича') && l.includes('set');
    },
    intent: 'Чем list отличается от set?',
    confidence: 'high',
    reason: 'list vs set Python comparison',
  },
  {
    test: (text) => {
      const l = text.toLowerCase();
      return l.includes('чем') && l.includes('tuple') && l.includes('отлича') && l.includes('set');
    },
    intent: 'Чем tuple отличается от set?',
    confidence: 'high',
    reason: 'tuple vs set Python comparison',
  },
  {
    test: (text) => {
      const l = text.toLowerCase();
      return (
        l.includes('чем') &&
        l.includes('smoke testing') &&
        l.includes('отлича') &&
        (l.includes('integration') || !l.includes('regression'))
      );
    },
    intent: 'Чем smoke testing отличается от regression testing?',
    confidence: 'medium',
    reason:
      'in QA interview context, this is likely the common smoke vs regression question; ' +
      'integration is kept as possible ambiguity',
    ambiguity: 'integration testing is also a valid QA term',
  },
  {
    test: (text) => /полинул/i.test(text),
    intent: 'Что такое Linux?',
    confidence: 'medium',
    reason: 'ASR garbled «Linux» as «полинулось» in a short QA question',
  },
  {
    test: (text) => {
      const l = text.toLowerCase();
      return /настраивал\w*\s+pipeline/i.test(l) && /к[а]?жд\w*/i.test(l);
    },
    intent: 'Как ты настраивал pipeline?',
    confidence: 'medium',
    reason: 'ASR likely garbled «Как ты» as «Каждый» in a pipeline setup question',
  },
  {
    test: (text) => {
      const l = text.toLowerCase();
      return (
        (/плей[\s-]?прайд|playwright/i.test(l) || l.includes('playwright')) &&
        /запуск/i.test(l)
      );
    },
    intent: 'Как ты запускал Playwright?',
    confidence: 'medium',
    reason: 'messy ASR with Playwright alias and launch intent',
  },
  {
    test: (text) => {
      const l = text.toLowerCase();
      return (
        /(?:bug|bag|back|bakr|баг|бак)\s*[-\s]?report/i.test(l) ||
        /(?:bug|bag|back|bakr|баг|бак)\s*[-\s]?репорт/i.test(l) ||
        /что\s+должн\w*\s+быть\s+в\s+(?:bug|bag|back|bakr|баг|бак)/i.test(l)
      );
    },
    intent: 'Что должно быть в bug report?',
    confidence: 'high',
    reason: 'ASR garbled bug report as Bakr/bag/back report',
  },
];

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[?.!,;:—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeForMatch(text).split(' ').filter((t) => t.length > 1));
}

function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) inter += 1;
  }
  return inter / (sa.size + sb.size - inter);
}

function extractKeyTerms(text: string): string[] {
  const terms = [
    'ci/cd',
    'jenkins',
    'gitlab ci',
    'docker',
    'rest api',
    'pytest fixtures',
    'page object model',
    'kafka',
    'linux',
    'list',
    'tuple',
    'set',
    'dict',
    'gil',
    'async',
    'oop',
    'allure report',
    'playwright',
    'pipeline',
    'smoke testing',
    'regression testing',
    'http методы',
  ];
  const l = text.toLowerCase();
  return terms.filter((t) => l.includes(t));
}

function matchQuestionBank(corrected: string): {
  intent: string;
  confidence: CorrectionConfidence;
  reason: string;
} | null {
  if (corrected.length > SHORT_QUESTION_MAX) return null;

  let best = '';
  let bestScore = 0;

  for (const canonical of QA_QUESTION_BANK) {
    const score = jaccardSimilarity(corrected, canonical);
    if (score > bestScore) {
      bestScore = score;
      best = canonical;
    }
  }

  const correctedTerms = extractKeyTerms(corrected);
  const bestTerms = extractKeyTerms(best);
  const termOverlap =
    correctedTerms.length > 0 &&
    bestTerms.length > 0 &&
    correctedTerms.some((t) => bestTerms.includes(t));

  if (bestScore >= 0.72 || (bestScore >= 0.55 && termOverlap)) {
    return {
      intent: best,
      confidence: bestScore >= 0.85 ? 'high' : 'medium',
      reason: `fuzzy match to question bank (${Math.round(bestScore * 100)}% similarity)`,
    };
  }

  return null;
}

function applyPhraseRules(text: string): PhraseRule | null {
  for (const rule of PHRASE_RULES) {
    if (rule.test(text)) return rule;
  }
  return null;
}

function findPhraseRule(...texts: string[]): PhraseRule | null {
  for (const text of texts) {
    if (!text.trim()) continue;
    const rule = applyPhraseRules(text);
    if (rule) return rule;
  }
  return null;
}

export function correctQuestionIntent(input: IntentCorrectionInput): IntentCorrectionResult {
  const raw = input.raw.trim();
  const corrected = input.corrected.trim();

  if (!corrected) {
    return {
      raw,
      corrected: '',
      intentCorrected: '',
      intentCorrections: [],
      changed: false,
      confidence: 'none',
    };
  }

  const phraseRule = findPhraseRule(corrected, raw);
  if (phraseRule && phraseRule.intent !== corrected) {
    return {
      raw,
      corrected,
      intentCorrected: phraseRule.intent,
      intentCorrections: [
        {
          from: corrected,
          to: phraseRule.intent,
          reason: phraseRule.reason,
          confidence: phraseRule.confidence,
        },
      ],
      changed: true,
      confidence: phraseRule.confidence,
      reason: phraseRule.reason,
      ambiguity: phraseRule.ambiguity,
    };
  }

  const bankMatch = matchQuestionBank(corrected);
  if (bankMatch && bankMatch.intent !== corrected) {
    return {
      raw,
      corrected,
      intentCorrected: bankMatch.intent,
      intentCorrections: [
        {
          from: corrected,
          to: bankMatch.intent,
          reason: bankMatch.reason,
          confidence: bankMatch.confidence,
        },
      ],
      changed: true,
      confidence: bankMatch.confidence,
      reason: bankMatch.reason,
    };
  }

  return {
    raw,
    corrected,
    intentCorrected: corrected,
    intentCorrections: [],
    changed: false,
    confidence: 'none',
  };
}
