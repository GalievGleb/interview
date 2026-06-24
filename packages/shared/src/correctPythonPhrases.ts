import type { AppliedCorrection, CorrectionConfidence } from './correctTranscriptWithGlossary';

const COMPARE_CONTEXT_RE =
  /(?:^|\s)(?:чем|разниц|отлича|между|list|лист|tuple|typo|тупл|кортеж|set|список)/iu;

interface PhraseFix {
  re: RegExp;
  to: string;
  confidence: CorrectionConfidence;
  reason: string;
}

const PYTHON_PHRASE_FIXES: PhraseFix[] = [
  {
    re: /чем\s+(?:list|лист[\p{L}]*|списк[\p{L}]*)\s+отлича[\p{L}]*\s+от\s+(?:tuple|typo|type\s*o|типо|тайпо|тупл[\p{L}]*|тапл[\p{L}]*|кортеж[\p{L}]*)\??/giu,
    to: 'Чем list отличается от tuple?',
    confidence: 'high',
    reason: 'ASR: лист/list vs typo/tuple comparison',
  },
  {
    re: /чем\s+list\s+отлича[\p{L}]*\s+от\s+set\b\??/giu,
    to: 'Чем list отличается от set?',
    confidence: 'high',
    reason: 'list vs set comparison',
  },
  {
    re: /чем\s+tuple\s+отлича[\p{L}]*\s+от\s+set\b\??/giu,
    to: 'Чем tuple отличается от set?',
    confidence: 'high',
    reason: 'tuple vs set comparison',
  },
];

const TOKEN_FIXES: Array<{
  re: RegExp;
  to: string;
  confidence: CorrectionConfidence;
  needsCompare: boolean;
}> = [
  { re: /(?<![\p{L}\p{N}])лист(?![\p{L}\p{N}])/giu, to: 'list', confidence: 'medium', needsCompare: true },
  { re: /(?<![\p{L}\p{N}])листы(?![\p{L}\p{N}])/giu, to: 'list', confidence: 'medium', needsCompare: true },
  {
    re: /(?<![\p{L}\p{N}])списк(?:и|а|ов)?(?![\p{L}\p{N}])/giu,
    to: 'list',
    confidence: 'low',
    needsCompare: true,
  },
  { re: /(?<![\p{L}\p{N}])typo(?![\p{L}\p{N}])/giu, to: 'tuple', confidence: 'high', needsCompare: true },
  { re: /(?<![\p{L}\p{N}])type\s*o(?![\p{L}\p{N}])/giu, to: 'tuple', confidence: 'high', needsCompare: true },
  { re: /(?<![\p{L}\p{N}])типо(?![\p{L}\p{N}])/giu, to: 'tuple', confidence: 'medium', needsCompare: true },
  { re: /(?<![\p{L}\p{N}])тайпо(?![\p{L}\p{N}])/giu, to: 'tuple', confidence: 'medium', needsCompare: true },
  {
    re: /(?<![\p{L}\p{N}])тупл[\p{L}]*(?![\p{L}\p{N}])/giu,
    to: 'tuple',
    confidence: 'medium',
    needsCompare: true,
  },
  { re: /(?<![\p{L}\p{N}])тапл[\p{L}]*(?![\p{L}\p{N}])/giu, to: 'tuple', confidence: 'medium', needsCompare: true },
  {
    re: /(?<![\p{L}\p{N}])кортеж(?:и|а|ей|ам)?(?![\p{L}\p{N}])/giu,
    to: 'tuple',
    confidence: 'low',
    needsCompare: true,
  },
];

export interface PythonPhraseCorrectionResult {
  corrected: string;
  corrections: AppliedCorrection[];
  changed: boolean;
}

/** Python QA phrase + token fixes after glossary pass. */
export function applyPythonPhraseCorrections(text: string): PythonPhraseCorrectionResult {
  const raw = text.trim();
  if (!raw) {
    return { corrected: '', corrections: [], changed: false };
  }

  let corrected = raw;
  const corrections: AppliedCorrection[] = [];

  for (const fix of PYTHON_PHRASE_FIXES) {
    if (!fix.re.test(corrected)) continue;
    fix.re.lastIndex = 0;
    const from = corrected;
    corrected = corrected.replace(fix.re, fix.to);
    if (corrected !== from) {
      corrections.push({ from, to: corrected, confidence: fix.confidence });
      break;
    }
  }

  const compareCtx = COMPARE_CONTEXT_RE.test(corrected) || COMPARE_CONTEXT_RE.test(raw);
  if (compareCtx) {
    for (const fix of TOKEN_FIXES) {
      if (fix.needsCompare && !compareCtx) continue;
      fix.re.lastIndex = 0;
      const match = fix.re.exec(corrected);
      if (!match) continue;
      const from = match[0];
      corrected = corrected.slice(0, match.index!) + fix.to + corrected.slice(match.index! + from.length);
      corrections.push({ from, to: fix.to, confidence: fix.confidence });
    }
    corrected = corrected.replace(/отличает(?=\s+от\b)/giu, 'отличается');
    if (/отличается/i.test(corrected) && !corrected.endsWith('?')) {
      corrected = corrected.replace(/\s*\.?\s*$/, '?');
    }
  }

  return {
    corrected,
    corrections,
    changed: corrected !== raw,
  };
}

/** Orphan tail like «от typo?» without prior comparative context. */
export function isOrphanComparativeTail(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  return /^от\s+(?:typo|tuple|тупл|типо|list|лист|set|кортеж)/iu.test(t);
}
