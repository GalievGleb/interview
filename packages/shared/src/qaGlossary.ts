import glossaryData from './qaGlossary.json';

export interface QaGlossaryEntry {
  canonical: string;
  aliases: string[];
  /** Aliases that map only in QA interview context (e.g. "open" → OOP). */
  contextOnlyAliases?: string[];
}

/**
 * Single source of truth for QA/Python ASR correction terms.
 *
 * The term data lives in `qaGlossary.json` so the Python STT-benchmark
 * corrector (`apps/api-py/app/services/stt/glossary.py`) can read the exact
 * same list — no drift between the desktop live pipeline and the backend
 * benchmark. Edit the JSON, not this file.
 */
export const QA_GLOSSARY: QaGlossaryEntry[] = glossaryData as unknown as QaGlossaryEntry[];

export const QA_GLOSSARY_CANONICAL_TERMS = QA_GLOSSARY.map((e) => e.canonical);
