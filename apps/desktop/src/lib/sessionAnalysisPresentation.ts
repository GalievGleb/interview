export interface SessionEvidenceLayout {
  hasStrengths: boolean;
  hasWeaknesses: boolean;
  hasAny: boolean;
  isSplit: boolean;
}

export function resolveSessionEvidenceLayout(
  strengthCount: number,
  weaknessCount: number,
): SessionEvidenceLayout {
  const hasStrengths = strengthCount > 0;
  const hasWeaknesses = weaknessCount > 0;

  return {
    hasStrengths,
    hasWeaknesses,
    hasAny: hasStrengths || hasWeaknesses,
    isSplit: hasStrengths && hasWeaknesses,
  };
}
