const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function signMacPreview(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(__dirname, 'entitlements.mac.preview.plist');
  execFileSync('codesign', [
    '--force', '--deep', '--sign', '-', '--options', 'runtime',
    '--entitlements', entitlements, app,
  ], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
