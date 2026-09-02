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

  it('defines a private isolated Alpha installer without a public update feed', () => {
    const alphaConfigPath = path.join(desktopRoot, 'electron-builder.alpha.cjs');
    expect(fs.existsSync(alphaConfigPath)).toBe(true);
    if (!fs.existsSync(alphaConfigPath)) return;

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const alphaConfigSource = fs.readFileSync(alphaConfigPath, 'utf8');

    expect(packageJson.scripts['build:alpha']).toContain('--mode alphabuild');
    expect(packageJson.scripts['dist:alpha']).toContain('dist:alpha:app');
    expect(packageJson.scripts['dist:alpha:app']).toContain('electron-builder.alpha.cjs');
    expect(packageJson.scripts['dist:alpha:app']).toContain('--publish never');
    expect(alphaConfigSource).toContain("appId: 'com.interview.assistant.alpha'");
    expect(alphaConfigSource).toContain("productName: 'SkillCue Alpha'");
    expect(alphaConfigSource).toContain("output: 'release-alpha'");
    expect(alphaConfigSource).toContain("artifactName: 'SkillCue-Alpha-Setup.${ext}'");
    expect(alphaConfigSource).toContain("name: 'skillcue-alpha'");
    expect(alphaConfigSource).toContain("buildChannel: 'alpha'");
    expect(alphaConfigSource).toContain("schemes: ['skillcue-alpha']");
    expect(alphaConfigSource).toContain('publish: null');
  });

  it('keeps hosted stable releases manual-only and never publishes from the dev workflow', () => {
    const repoRoot = path.resolve(desktopRoot, '..', '..');
    const releaseWorkflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    const devWorkflow = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'dev-build.yml'),
      'utf8',
    );

    expect(releaseWorkflow).toContain('workflow_dispatch:');
    expect(releaseWorkflow).not.toContain("tags: ['v*']");
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

  it('shows the canonical stealth/theme utilities and keeps taskbar control in Settings', () => {
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
    expect(sidebarSource).toContain('<Moon');
    expect(sidebarSource).toContain('nextSidebarTheme(theme)');
    expect(settingsSource).toContain('setSkipTaskbar(enabled)');
    expect(settingsSource).toContain('window.electronAPI?.window.setSkipTaskbar(enabled)');
    expect(licenseCardSource).not.toContain('if (!license) return null');
    expect(licenseCardSource).toContain("placeholder=\"SKILLCUE-…\"");
    expect(licenseCardSource).toContain("t('license.keyPrompt')");
    expect(settingsSource.indexOf('<LicenseCard')).toBeLessThan(settingsSource.indexOf('<PlanPicker'));
    expect(preloadSource).toContain("ipcRenderer.invoke('app:getBuildChannel')");
    expect(mainSource).toContain("ipcMain.handle('app:getBuildChannel', () => BUILD_CHANNEL)");
    expect(mainSource).toContain(
      "const isDeveloperBuild = BUILD_CHANNEL === 'dev' || BUILD_CHANNEL === 'alpha';",
    );
    expect(preloadSource).toContain("ipcRenderer.invoke('overlay:get-window-state')");
    expect(mainSource).toContain("ipcMain.handle('overlay:get-window-state'");
  });

  it('tree-shakes developer routes out of the stable product', () => {
    const appSource = fs.readFileSync(path.join(desktopRoot, 'src', 'App.tsx'), 'utf8');
    const paletteSource = fs.readFileSync(
      path.join(desktopRoot, 'src', 'components', 'CommandPalette.tsx'),
      'utf8',
    );

    expect(appSource).toContain(
      "const DEV_SURFACE = ['devbuild', 'alphabuild'].includes(import.meta.env.MODE);",
    );
    expect(appSource).toContain("DEV_SURFACE ? lazy(() => import('./pages/DiagnosticsPage')) : null");
    expect(appSource).toContain('DEV_SURFACE && DiagnosticsPage');
    expect(appSource).not.toContain('function DeveloperGate');
    expect(paletteSource).toContain("buildChannel === 'dev' || buildChannel === 'alpha'");
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
