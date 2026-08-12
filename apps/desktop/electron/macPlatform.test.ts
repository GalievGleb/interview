import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserCandidatePaths } from './hhBrowserAssistant';

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');

describe('macOS desktop distribution', () => {
  it('discovers the standard macOS browser app bundles used by HH automation', () => {
    const candidates = browserCandidatePaths('darwin', { HOME: '/Users/tester' });

    expect(candidates).toEqual(expect.arrayContaining([
      {
        label: 'Google Chrome',
        executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      {
        label: 'Microsoft Edge',
        executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      },
      {
        label: 'Google Chrome',
        executable: '/Users/tester/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
    ]));
  });

  it('builds, smoke-tests, and publishes native Apple silicon and Intel DMGs', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );

    expect(workflow).toContain('runs-on: ${{ matrix.runner }}');
    expect(workflow).toContain('runner: macos-15');
    expect(workflow).toContain('arch: arm64');
    expect(workflow).toContain('runner: macos-15-intel');
    expect(workflow).toContain('arch: x64');
    expect(workflow).toContain('skillcue-backend');
    expect(workflow).toContain('Smoke-test packaged macOS app');
    expect(workflow).toContain('SkillCue-macOS-${{ matrix.arch }}.dmg');
    expect(workflow).toContain('gh release upload');
  });

  it('uses native macOS window controls and does not request Windows update metadata', () => {
    const mainSource = fs.readFileSync(
      path.join(desktopRoot, 'electron', 'main.ts'),
      'utf8',
    );

    expect(mainSource).toContain("titleBarStyle: 'hiddenInset'");
    expect(mainSource).toContain("process.platform === 'win32'");
    expect(mainSource).toContain('if (!isAutoUpdateSupported) return;');
    expect(mainSource).toContain('Обновления macOS пока устанавливаются новой версией с сайта');
  });

  it('offers both macOS architectures on the Russian and English landing pages', () => {
    for (const relative of ['landing/index.html', 'landing/en/index.html']) {
      const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
      expect(source).toContain('/releases/latest/download/SkillCue-macOS-arm64.dmg');
      expect(source).toContain('/releases/latest/download/SkillCue-macOS-x64.dmg');
    }
  });
});
