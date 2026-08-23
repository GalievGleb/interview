import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(__dirname, '..');

describe('packaged product surface', () => {
  it('never ships developer verification assets in the stable product', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
    ) as {
      build: { extraResources: Array<{ from?: string; to?: string }> };
      scripts: Record<string, string>;
    };
    const devConfigSource = fs.readFileSync(
      path.join(desktopRoot, 'electron-builder.dev.cjs'),
      'utf8',
    );

    // Stable installers must not contain dev/test fixtures (CLAUDE.md rule).
    const stableResourceTargets = packageJson.build.extraResources.map((r) => r.to ?? '');
    expect(stableResourceTargets).not.toContain('tests/stt-benchmark/cases.json');
    expect(stableResourceTargets).not.toContain('tests/voice/audio');
    for (const resource of packageJson.build.extraResources) {
      expect(resource.from ?? '').not.toContain('tests/');
    }

    // The private Dev installer keeps them so the Test Lab / benchmark and the
    // installed-overlay verification keep working against Dev builds.
    expect(devConfigSource).toContain('../../tests/stt-benchmark/cases.json');
    expect(devConfigSource).toContain('../../tests/voice/audio');

    expect(packageJson.scripts['build:backend']).toContain(
      '.venv\\Scripts\\pyinstaller.exe -y',
    );
    expect(packageJson).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+(?:-dev)?$/) });
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

  it('shows stealth and taskbar shortcuts in the sidebar for every build', () => {
    const sidebarSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'components', 'Sidebar.tsx'),
      'utf8',
    );
    const preloadSource = fs.readFileSync(path.join(desktopRoot, 'electron', 'preload.ts'), 'utf8');
    const mainSource = fs.readFileSync(path.join(desktopRoot, 'electron', 'main.ts'), 'utf8');
    const settingsSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'pages', 'SettingsPage.tsx'),
      'utf8',
    );
    const licenseCardSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'components', 'LicenseCard.tsx'),
      'utf8',
    );

    expect(sidebarSource).not.toContain('{isDeveloperBuild && (');
    expect(sidebarSource).toContain('skillcue-sidebar__utility-row');
    expect(sidebarSource).toContain('<ShieldCheck');
    expect(sidebarSource).toContain('<EyeOff');
    expect(licenseCardSource).not.toContain('if (!license) return null');
    expect(licenseCardSource).toContain("placeholder=\"SKILLCUE-…\"");
    expect(licenseCardSource).toContain("t('license.keyPrompt')");
    expect(settingsSource.indexOf('<LicenseCard')).toBeLessThan(settingsSource.indexOf('<PlanPicker'));
    expect(preloadSource).toContain("ipcRenderer.invoke('app:getBuildChannel')");
    expect(mainSource).toContain("ipcMain.handle('app:getBuildChannel', () => BUILD_CHANNEL)");
    expect(preloadSource).toContain("ipcRenderer.invoke('overlay:get-window-state')");
    expect(mainSource).toContain("ipcMain.handle('overlay:get-window-state'");
  });

  it('tree-shakes developer routes out of the stable product', () => {
    const appSource = fs.readFileSync(path.join(desktopRoot, 'src', 'App.tsx'), 'utf8');
    const paletteSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'components', 'CommandPalette.tsx'),
      'utf8',
    );

    expect(appSource).toContain("const DEV_SURFACE = import.meta.env.MODE === 'devbuild';");
    expect(appSource).toContain("DEV_SURFACE ? lazy(() => import('./pages/DiagnosticsPage')) : null");
    expect(appSource).toContain('DEV_SURFACE && DiagnosticsPage');
    expect(appSource).not.toContain('function DeveloperGate');
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
