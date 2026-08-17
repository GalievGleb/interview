import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const toast = fs.readFileSync(path.resolve(__dirname, 'UpdateToast.tsx'), 'utf8');
const settings = fs.readFileSync(path.resolve(__dirname, '../pages/SettingsPage.tsx'), 'utf8');
const main = fs.readFileSync(path.resolve(__dirname, '../../electron/main.ts'), 'utf8');

describe('automatic update UI', () => {
  it('silently installs and force-runs the downloaded update', () => {
    expect(main).toContain('quitAndInstall(true, true)');
    expect(main).toContain('updateCoordinator.markDownloaded(info.version)');
  });

  it('shows an Update button on the right when a newer build exists', () => {
    const layout = fs.readFileSync(path.resolve(__dirname, 'Layout.tsx'), 'utf8');
    expect(layout).toContain("t('update.apply')");
    expect(layout).toContain('shouldShowUpdateButton');
    expect(layout).toContain("window.electronAPI?.updater?.install()");
    expect(settings).toContain("t('update.apply')");
    expect(settings).toContain('shouldShowUpdateButton(updaterStatus.state)');
    expect(toast).toContain("t('update.apply')");
    expect(toast).toContain("window.electronAPI?.updater?.install()");
  });

  it('does not repeat download percentage in status text and a disabled button', () => {
    expect(settings).toContain('sc-progress');
    expect(settings).not.toContain(
      "`${t('settings.update.downloading')} ${updaterStatus.percent ?? 0}%`",
    );
  });

  it('uses block elements for the fixed-size progress bars', () => {
    expect(toast).toContain('<div className="sc-progress">');
    expect(settings).toMatch(/<div\s+className="sc-progress"/);
  });

  it('suppresses the global toast on settings', () => {
    expect(toast).toContain("pathname === '/settings'");
  });
});
