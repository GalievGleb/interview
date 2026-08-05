import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
) as {
  build: {
    afterPack?: string;
  };
};

describe('Windows mixed-DPI packaging', () => {
  it('embeds a Per-Monitor V2 manifest after electron-builder packs the app', () => {
    expect(packageJson.build.afterPack).toBe('build/applyWindowsDpiManifest.cjs');

    const manifestPath = path.join(desktopRoot, 'build', 'skillcue.exe.manifest');
    const hookPath = path.join(desktopRoot, 'build', 'applyWindowsDpiManifest.cjs');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(hookPath)).toBe(true);

    const manifest = fs.readFileSync(manifestPath, 'utf8');
    const hook = fs.readFileSync(hookPath, 'utf8');

    expect(manifest).toContain(
      '<dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>',
    );
    expect(manifest).toContain(
      '<dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2,PerMonitor</dpiAwareness>',
    );
    expect(manifest).toContain(
      '<disableWindowFiltering xmlns="http://schemas.microsoft.com/SMI/2011/WindowsSettings">true</disableWindowFiltering>',
    );
    expect(manifest).toContain(
      '<requestedExecutionLevel level="asInvoker" uiAccess="false"/>',
    );
    expect(manifest).toContain('name="Microsoft.Windows.Common-Controls"');
    expect(manifest).toContain(
      '<maxversiontested Id="10.0.18362.0"/>',
    );
    expect(hook).toContain("'--application-manifest'");
    expect(hook).toContain("process.platform !== 'win32'");
    expect(hook).toContain(
      "process.env.ELECTRON_BUILDER_DISABLE_BUILD_CACHE = 'true';",
    );
  });
});
