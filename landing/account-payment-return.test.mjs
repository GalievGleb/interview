import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const name of ['account-payment-success.html', 'account-payment-cancel.html']) {
  test(`${name} only opens an allowlisted SkillCue channel`, async () => {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.match(source, /channel === 'alpha'/);
    assert.match(source, /skillcue-alpha:\/\/payment-/);
    assert.doesNotMatch(source, /params\.get\(['"]return['"]\)/);
  });
}
