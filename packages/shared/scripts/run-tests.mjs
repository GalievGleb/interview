// Runs every standalone hand-rolled test (src/*.test.ts) via tsx and fails if
// any of them fails. Keeps all shared tests gated in CI, not just one.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const tests = readdirSync(srcDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

let failed = 0;
for (const file of tests) {
  const path = join(srcDir, file);
  process.stdout.write(`\n▶ ${file}\n`);
  try {
    execFileSync('npx', ['-y', 'tsx', path], { stdio: 'inherit', shell: process.platform === 'win32' });
  } catch {
    failed += 1;
    process.stdout.write(`✖ ${file} FAILED\n`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${tests.length} shared test file(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} shared test files passed`);
