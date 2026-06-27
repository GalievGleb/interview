/**
 * Cross-language drift guard: the SAME fixtures
 * (packages/shared/fixtures/sanitizer-cases.json) are asserted here and in the
 * Python suite (apps/api-py/tests/test_sanitizer_fixtures.py). If the TS and
 * Python sanitizers diverge, one of the suites fails.
 *
 * Run: npx tsx packages/shared/src/sanitizerFixtures.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeLiveAnswer } from './sanitizeLiveAnswer';

interface Case {
  name: string;
  input: string;
  equals?: string;
  mustContain?: string[];
  mustNotContain?: string[];
}

const fixturesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sanitizer-cases.json',
);
const cases: Case[] = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

let failed = 0;
for (const c of cases) {
  const out = sanitizeLiveAnswer(c.input);
  const errors: string[] = [];
  if (c.equals !== undefined && out !== c.equals) errors.push(`expected exactly "${c.equals}"`);
  for (const s of c.mustContain ?? []) if (!out.includes(s)) errors.push(`must contain "${s}"`);
  for (const s of c.mustNotContain ?? [])
    if (out.toLowerCase().includes(s.toLowerCase())) errors.push(`must NOT contain "${s}"`);
  if (errors.length) {
    failed += 1;
    console.error(`FAIL [${c.name}]: ${errors.join('; ')}\n  got: ${out}`);
  } else {
    console.log(`OK: ${c.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} sanitizer fixtures failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} sanitizer fixtures passed`);
