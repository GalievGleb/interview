import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(__dirname, '../..');
const buildRoot = path.join(desktopRoot, 'build');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'),
) as {
  scripts: Record<string, string>;
  build: {
    nsis: Record<string, unknown>;
  };
};
const installerIncludePath = path.join(buildRoot, 'installer.nsh');

function readBitmap(name: string) {
  const data = fs.readFileSync(path.join(buildRoot, name));
  return {
    data,
    signature: data.toString('ascii', 0, 2),
    declaredSize: data.readUInt32LE(2),
    pixelOffset: data.readUInt32LE(10),
    dibHeaderSize: data.readUInt32LE(14),
    width: data.readInt32LE(18),
    height: data.readInt32LE(22),
    planes: data.readUInt16LE(26),
    bitsPerPixel: data.readUInt16LE(28),
    compression: data.readUInt32LE(30),
  };
}

describe('Windows installer artwork', () => {
  it.each([
    ['installerHeader.bmp', 150, 57],
    ['installerSidebar.bmp', 164, 314],
    ['uninstallerSidebar.bmp', 164, 314],
  ])('ships %s as an uncompressed 24-bit bitmap', (name, width, height) => {
    const bitmap = readBitmap(name);
    const rowStride = Math.ceil((width * 3) / 4) * 4;

    expect(bitmap.signature).toBe('BM');
    expect(bitmap.declaredSize).toBe(bitmap.data.length);
    expect(bitmap.dibHeaderSize).toBe(40);
    expect(bitmap.width).toBe(width);
    expect(bitmap.height).toBe(height);
    expect(bitmap.planes).toBe(1);
    expect(bitmap.bitsPerPixel).toBe(24);
    expect(bitmap.compression).toBe(0);
    expect(bitmap.pixelOffset + rowStride * height).toBe(bitmap.data.length);
  });

  it('uses a progress-only per-user installer that launches automatically', () => {
    expect(packageJson.scripts['assets:installer']).toBe('python build/make_icon.py');
    expect(packageJson.scripts.prebuild).toBe('pnpm assets:installer');
    expect(packageJson.build.nsis).toMatchObject({
      oneClick: true,
      perMachine: false,
      allowToChangeInstallationDirectory: false,
      deleteAppDataOnUninstall: false,
    });
    expect(packageJson.build.nsis).not.toHaveProperty('installerSidebar');
  });

  it('migrates the old resume and history before replacing an installation', () => {
    const include = fs.readFileSync(installerIncludePath, 'utf8');
    expect(include).toContain('customCheckAppRunning');
    expect(include).toContain('!insertmacro _CHECK_APP_RUNNING');
    expect(include).toContain('$APPDATA\\@interview\\desktop\\backend-data');
    expect(include).toContain('$INSTDIR\\resources\\backend\\_internal\\data');
    expect(include).toContain('$DESKTOP\\Skillcue\\resources\\backend\\_internal\\data');
    expect(include).toContain('CopyFiles /SILENT');
  });
});
