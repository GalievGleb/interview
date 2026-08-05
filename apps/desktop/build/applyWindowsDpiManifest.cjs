const path = require('node:path');
const { createRequire } = require('node:module');

function loadExecuteAppBuilder() {
  // Keep using the exact rcedit binary already bundled with electron-builder.
  // Resolving through electron-builder also works with pnpm's isolated layout.
  const electronBuilderRequire = createRequire(require.resolve('electron-builder'));
  const appBuilderLibEntry = electronBuilderRequire.resolve('app-builder-lib');
  const appBuilderRequire = createRequire(appBuilderLibEntry);
  return appBuilderRequire('builder-util').executeAppBuilder;
}

module.exports = async function applyWindowsDpiManifest(context) {
  if (process.platform !== 'win32' || context.electronPlatformName !== 'win32') return;

  // electron-builder signs/edits the executable after afterPack. Its local signed
  // executable cache does not include custom manifest hooks in the cache key and
  // could otherwise restore an older executable over the PMv2 manifest below.
  process.env.ELECTRON_BUILDER_DISABLE_BUILD_CACHE = 'true';

  const executable = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  const manifest = path.join(__dirname, 'skillcue.exe.manifest');
  const executeAppBuilder = loadExecuteAppBuilder();

  await executeAppBuilder(
    ['rcedit', '--args', JSON.stringify([executable, '--application-manifest', manifest])],
    undefined,
    {},
    3,
  );
};
