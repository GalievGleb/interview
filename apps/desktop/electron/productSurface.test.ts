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

  it('keeps the private developer installer separate from the public product', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const devConfigSource = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.dev.cjs'),
      'utf8',
    );

    expect(packageJson.scripts['dist:dev']).toContain('dist:dev:app');
    expect(packageJson.scripts['dist:dev:app']).toContain('--publish never');
    expect(devConfigSource).toContain("appId: 'com.interview.assistant.dev'");
    expect(devConfigSource).toContain("productName: 'SkillCue Dev'");
    expect(devConfigSource).toContain("output: 'release-dev'");
    expect(devConfigSource).toContain("artifactName: 'SkillCue-Dev-Setup.${ext}'");
    expect(devConfigSource).toContain("name: 'skillcue-dev'");
    expect(devConfigSource).toContain("buildChannel: 'dev'");
    expect(devConfigSource).toContain('publish: null');
  });

  it('publishes stable releases only from tags and never from the dev workflow', () => {
    const repoRoot = path.resolve(desktopRoot, '..', '..');
    const releaseWorkflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const devWorkflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'dev-build.yml'),
      'utf8',
    );

    expect(releaseWorkflow).toContain("tags: ['v*']");
    expect(releaseWorkflow).not.toContain('workflow_dispatch:');
    expect(releaseWorkflow).toContain('--publish always');
    expect(devWorkflow).toContain('workflow_dispatch:');
    expect(devWorkflow).toContain('--publish never');
    expect(devWorkflow).toContain('actions/upload-artifact@v4');
  });

  it('does not expose manual model selection in Settings', () => {
    const settingsSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'pages', 'SettingsPage.tsx'),
      'utf8',
    );

    expect(settingsSource).not.toContain("id: 'ai'");
    expect(settingsSource).not.toContain('<AiModelsSettings />');
  });

  it('keeps public Settings compact and focused on the microphone test', () => {
    const settingsSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'pages', 'SettingsPage.tsx'),
      'utf8',
    );

    expect(settingsSource).not.toContain("id: 'privacy'");
    expect(settingsSource).not.toContain("id: 'developer'");
    expect(settingsSource).not.toContain('<SpeechRecognitionSettings />');
    expect(settingsSource).toContain("tab === 'speech' && <MicrophoneSettings />");
    expect(settingsSource).not.toContain('electronAPI?.quit');
    expect(settingsSource.match(/openSupportLink\(SUPPORT_TELEGRAM_URL\)/g)).toHaveLength(1);
  });

  it('shows the old stealth shortcuts only in the developer build', () => {
    const sidebarSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'components', 'Sidebar.tsx'),
      'utf8',
    );
    const preloadSource = fs.readFileSync(path.join(desktopRoot, 'electron', 'preload.ts'), 'utf8');
    const mainSource = fs.readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8');

    expect(sidebarSource).toContain('useBuildChannel()');
    expect(sidebarSource).toContain("buildChannel === 'dev'");
    expect(sidebarSource).toContain('{isDeveloperBuild && (');
    expect(sidebarSource).toContain('skillcue-sidebar__utility-row');
    expect(sidebarSource).toContain('<ShieldCheck');
    expect(sidebarSource).toContain('<EyeOff');
    expect(preloadSource).toContain("ipcRenderer.invoke('app:getBuildChannel')");
    expect(mainSource).toContain("ipcMain.handle('app:getBuildChannel', () => BUILD_CHANNEL)");
    expect(preloadSource).toContain("ipcRenderer.invoke('overlay:get-window-state')");
    expect(mainSource).toContain("ipcMain.handle('overlay:get-window-state'");
  });

  it('fails closed for developer routes and commands in the stable product', () => {
    const appSource = fs.readFileSync(path.join(desktopRoot, 'src', 'App.tsx'), 'utf8');
    const paletteSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'components', 'CommandPalette.tsx'),
      'utf8',
    );

    expect(appSource).toContain('function DeveloperGate');
    expect(appSource).toContain("if (channel !== 'dev') return <Navigate to=\"/home\" replace />");
    expect(appSource).toContain('<DeveloperGate><DiagnosticsPage /></DeveloperGate>');
    expect(appSource).toContain("if (buildChannel === 'dev')");
    expect(paletteSource).toContain("buildChannel === 'dev'");
    expect(paletteSource).not.toContain("startsWith('dev')");
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
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
    ) as { version: string };
    const releaseNotesSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'lib', 'releaseNotes.ts'),
      'utf8',
    );

    expect(releaseNotesSource).toContain(`version: '${packageJson.version}'`);
  });
});
