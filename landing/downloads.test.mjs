import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runtimeSource = await readFile(new URL('./assets/site-runtime.js', import.meta.url), 'utf8');
const { detectDesktopPlatform, getDownloadTarget } = await import(
  `data:text/javascript;base64,${Buffer.from(runtimeSource).toString('base64')}`
);

test('a MacIntel browser does not silently select the Intel build', () => {
  const platform = detectDesktopPlatform({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    platform: 'MacIntel',
  });
  assert.equal(platform, 'mac');
  assert.equal(getDownloadTarget(platform).href, '#downloads');
  assert.match(getDownloadTarget(platform).label, /Выбрать версию/u);
});

test('Mac download links identify the released version and architecture', async () => {
  for (const page of ['./index.html', './en/index.html', './pay-success.html']) {
    const html = await readFile(new URL(page, import.meta.url), 'utf8');
    assert.match(html, /releases\/download\/v0\.1\.16\/SkillCue-macOS-arm64\.dmg/u);
    assert.match(html, /releases\/download\/v0\.1\.15\/SkillCue-macOS-x64\.dmg/u);
    assert.doesNotMatch(html, /releases\/latest\/download\/SkillCue-macOS-/u);
  }
});
