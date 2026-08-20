import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./pay-success.html', import.meta.url), 'utf8');

test('keeps a manual activation path and a visible key', () => {
  assert.match(source, /<code id="key">/);
  assert.match(source, /Настройки → Лицензия → вставьте ключ/);
  assert.match(source, /skillcue:\/\/activate\?key=/);
});

test('copies the key even when the Clipboard API is unavailable', () => {
  assert.match(source, /async function copyActivationKey/);
  assert.match(source, /navigator\.clipboard\?\.writeText/);
  assert.match(source, /document\.execCommand\(['"]copy['"]\)/);
});

test('retries status polling without creating a second payment', () => {
  assert.match(source, /id="retryBtn"/);
  assert.match(source, /retryBtn.*addEventListener/s);
  assert.doesNotMatch(source, /method:\s*['"]POST['"]/);
});
