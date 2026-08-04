import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(__dirname, '..');

describe('packaged product surface', () => {
  it('ships the STT benchmark cases and source audio', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
    ) as {
      build: { extraResources: Array<{ from: string; to: string }> };
      scripts: Record<string, string>;
    };

    expect(packageJson.build.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: '../../tests/stt-benchmark/cases.json',
          to: 'tests/stt-benchmark/cases.json',
        }),
        expect.objectContaining({
          from: '../../tests/voice/audio',
          to: 'tests/voice/audio',
        }),
      ]),
    );
    expect(packageJson.scripts['build:backend']).toContain(
      '.venv\\Scripts\\pyinstaller.exe -y',
    );
    expect(packageJson).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });

  it('does not expose manual model selection in Settings', () => {
    const settingsSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'pages', 'SettingsPage.tsx'),
      'utf8',
    );

    expect(settingsSource).not.toContain("id: 'ai'");
    expect(settingsSource).not.toContain('<AiModelsSettings />');
  });

  it('keeps Home focused on one decision instead of duplicate summaries', () => {
    const homeSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'pages', 'HomePage.tsx'),
      'utf8',
    );

    expect(homeSource).not.toContain('prep-home-summary');
    expect(homeSource).not.toContain('prep-recent');
    expect(homeSource).not.toContain('<PreparationFlow');
  });

  it('shows the current desktop release in What is new', () => {
    const releaseNotesSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'lib', 'releaseNotes.ts'),
      'utf8',
    );

    expect(releaseNotesSource).toContain("version: '0.0.17'");
  });
});
