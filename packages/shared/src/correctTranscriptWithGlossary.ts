import { QA_GLOSSARY, QaGlossaryEntry } from './qaGlossary';

export type CorrectionConfidence = 'high' | 'medium' | 'low';

export interface AppliedCorrection {
  from: string;
  to: string;
  confidence: CorrectionConfidence;
}

export interface CorrectionResult {
  raw: string;
  corrected: string;
  corrections: AppliedCorrection[];
  changed: boolean;
  maxConfidence: CorrectionConfidence | 'none';
  needsLlmCorrection: boolean;
}

export interface CorrectTranscriptOptions {
  /** QA/AQA interview mode — enables context-only aliases. */
  interviewMode?: boolean;
  /** Aggressive fixes for short utterances (< 120 chars). */
  isShort?: boolean;
}

const QA_CONTEXT_RE =
  /(?:что\s+такое|расскаж|объясн|опиш|назов|перечисл|чем\s+.+\s+отлича|принцип|тестир|интервью|\bqa\b|\baqa\b|какие|какой|как\s+ты|проверял|настраивал|использовал|python|list|tuple|typo|лист|кортеж)/iu;

const SHORT_QUESTION_MAX = 120;

interface AliasRule {
  alias: string;
  canonical: string;
  confidence: CorrectionConfidence;
  contextOnly: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasPattern(alias: string): RegExp {
  const parts = alias.trim().split(/\s+/).map(escapeRegExp);
  const body = parts.join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

function inferConfidence(alias: string, entry: QaGlossaryEntry): CorrectionConfidence {
  const a = alias.toLowerCase().trim();
  if (entry.contextOnlyAliases?.some((x) => x.toLowerCase() === a)) return 'low';
  if (a.includes(' ') || a.length >= 10) return 'high';
  if (/[a-z]/i.test(a) && /[а-яё]/i.test(a)) return 'high';
  if (a.length >= 6) return 'medium';
  return 'medium';
}

function buildAliasRules(): AliasRule[] {
  const rules: AliasRule[] = [];
  for (const entry of QA_GLOSSARY) {
    const contextSet = new Set((entry.contextOnlyAliases ?? []).map((a) => a.toLowerCase()));
    for (const alias of entry.aliases) {
      rules.push({
        alias,
        canonical: entry.canonical,
        confidence: inferConfidence(alias, entry),
        contextOnly: contextSet.has(alias.toLowerCase()),
      });
    }
  }
  return rules.sort((a, b) => b.alias.length - a.alias.length);
}

const ALIAS_RULES = buildAliasRules();

function hasQaContext(text: string): boolean {
  return QA_CONTEXT_RE.test(text);
}

function shouldApplyRule(
  rule: AliasRule,
  text: string,
  opts: CorrectTranscriptOptions,
): boolean {
  if (!rule.contextOnly) {
    if (rule.confidence === 'high') return true;
    const isShort = opts.isShort ?? text.length <= SHORT_QUESTION_MAX;
    if (rule.confidence === 'medium') return isShort || hasQaContext(text);
    return (opts.interviewMode ?? true) && (hasQaContext(text) || isShort);
  }
  return (opts.interviewMode ?? true) && hasQaContext(text);
}

function maxConfidenceOf(corrections: AppliedCorrection[]): CorrectionResult['maxConfidence'] {
  if (corrections.length === 0) return 'none';
  const rank: Record<CorrectionConfidence, number> = { high: 3, medium: 2, low: 1 };
  let best: CorrectionConfidence = 'low';
  for (const c of corrections) {
    if (rank[c.confidence] > rank[best]) best = c.confidence;
  }
  return best;
}

/** True if text still contains known ASR alias fragments after glossary pass. */
export function hasSuspiciousTerms(text: string): boolean {
  const lower = text.toLowerCase();
  return ALIAS_RULES.some((rule) => aliasPattern(rule.alias).test(lower));
}

export function shouldRunLlmCorrection(result: CorrectionResult, raw: string): boolean {
  const short = raw.trim().length <= SHORT_QUESTION_MAX;
  const suspicious = hasSuspiciousTerms(raw);
  const mediumOrLow = result.corrections.some((c) => c.confidence !== 'high');
  if (result.changed && mediumOrLow) return true;
  if (short && suspicious) return true;
  if (result.changed && short) return true;
  return false;
}

export function correctTranscriptWithGlossary(
  rawTranscript: string,
  options: CorrectTranscriptOptions = {},
): CorrectionResult {
  const raw = rawTranscript.trim();
  if (!raw) {
    return {
      raw: '',
      corrected: '',
      corrections: [],
      changed: false,
      maxConfidence: 'none',
      needsLlmCorrection: false,
    };
  }

  const opts: CorrectTranscriptOptions = {
    interviewMode: options.interviewMode ?? true,
    isShort: options.isShort ?? raw.length <= SHORT_QUESTION_MAX,
  };

  let corrected = raw;
  const corrections: AppliedCorrection[] = [];

  for (const rule of ALIAS_RULES) {
    if (!shouldApplyRule(rule, corrected, opts)) continue;
    const re = aliasPattern(rule.alias);
    const match = re.exec(corrected);
    if (!match) continue;

    const from = match[0];
    const existing = corrected.slice(match.index!, match.index! + rule.canonical.length);
    // Already exactly canonical (incl. case) — nothing to do.
    if (existing === rule.canonical) continue;
    // A SHORT alias landing inside text a longer alias already corrected
    // (e.g. "smoke" inside "smoke testing") — don't re-expand. But a full-length
    // alias that differs only by case (e.g. "page object model") SHOULD be
    // normalized to the canonical casing ("Page Object Model").
    if (
      existing.toLowerCase() === rule.canonical.toLowerCase() &&
      from.length < rule.canonical.length
    ) {
      continue;
    }
    corrected = corrected.slice(0, match.index!) + rule.canonical + corrected.slice(match.index! + from.length);
    corrections.push({ from, to: rule.canonical, confidence: rule.confidence });
  }

  const changed = corrected !== raw;
  const maxConfidence = maxConfidenceOf(corrections);
  const result: CorrectionResult = {
    raw,
    corrected,
    corrections,
    changed,
    maxConfidence,
    needsLlmCorrection: false,
  };
  result.needsLlmCorrection = shouldRunLlmCorrection(result, raw);
  return result;
}
