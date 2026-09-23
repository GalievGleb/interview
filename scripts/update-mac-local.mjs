import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('This command is for macOS only.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const builtApp = path.join(desktop, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'SkillCue.app');
const installedApp = '/Applications/SkillCue.app';
const stagedApp = '/Applications/SkillCue.next.app';
const backupApp = path.join(desktop, 'release', 'SkillCue.previous.backup');
const backupZip = path.join(desktop, 'release', 'SkillCue.previous.zip');
const desktopAlias = path.join(os.homedir(), 'Desktop', 'SkillCue Local.app');
const desktopBackup = path.join(desktop, 'release', 'SkillCue Local.desktop-previous.backup');
const desktopBackupZip = path.join(desktop, 'release', 'SkillCue Local.desktop-previous.zip');

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}

function runningStableApps() {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Could not inspect running apps.');
  return result.stdout.split('\n').flatMap((line) => {
    if (!line.includes('/Contents/MacOS/SkillCue') || line.includes('/Contents/Frameworks/') || line.includes('SkillCue Alpha')) return [];
    const match = /^\s*(\d+)\s+(.*\/Contents\/MacOS\/SkillCue)(?:\s|$)/u.exec(line);
    return match ? [{ pid: Number(match[1]), executable: match[2] }] : [];
  });
}

function quitStableApps() {
  for (const { executable } of runningStableApps()) {
    const appPath = executable.slice(0, -'/Contents/MacOS/SkillCue'.length);
    run('osascript', ['-e', `tell application "${appPath.replaceAll('"', '\\"')}" to quit`]);
  }
  for (let attempt = 0; attempt < 40 && runningStableApps().length; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (runningStableApps().length) throw new Error('SkillCue is still running. Save your work, quit it, and retry.');
}

function archiveAppBackup(appPath, archivePath) {
  if (!fs.existsSync(appPath)) return;
  const nextArchive = `${archivePath}.next`;
  fs.rmSync(nextArchive, { force: true });
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, nextArchive]);
  run('unzip', ['-tq', nextArchive]);
  fs.renameSync(nextArchive, archivePath);
  fs.rmSync(appPath, { recursive: true, force: true });
}

run('pnpm', ['build:shared']);
run('pnpm', ['--filter', '@interview/desktop', 'build:backend']);
run('pnpm', ['--filter', '@interview/desktop', 'build']);
quitStableApps();
run('pnpm', ['exec', 'electron-builder', '--config', 'electron-builder.mac.cjs', '--mac', 'dir', '--publish', 'never'], desktop);
if (!fs.existsSync(builtApp)) throw new Error(`Built app not found: ${builtApp}`);

fs.rmSync(stagedApp, { recursive: true, force: true });
run('ditto', [builtApp, stagedApp]);
fs.rmSync(backupApp, { recursive: true, force: true });
if (fs.existsSync(installedApp)) fs.renameSync(installedApp, backupApp);
try {
  fs.renameSync(stagedApp, installedApp);
} catch (error) {
  if (fs.existsSync(backupApp)) fs.renameSync(backupApp, installedApp);
  throw error;
}
// One canonical Stable app avoids Launch Services opening an older copy with
// the same bundle identifier. Keep the previous Desktop bundle as a backup.
if (fs.existsSync(desktopAlias) && !fs.lstatSync(desktopAlias).isSymbolicLink()) {
  fs.rmSync(desktopBackup, { recursive: true, force: true });
  fs.renameSync(desktopAlias, desktopBackup);
}
if (fs.existsSync(desktopAlias)) fs.rmSync(desktopAlias, { recursive: true, force: true });
fs.symlinkSync(installedApp, desktopAlias);
archiveAppBackup(backupApp, backupZip);
archiveAppBackup(desktopBackup, desktopBackupZip);
// electron-builder's temporary app has the same bundle ID. Keeping it as a
// launchable .app lets macOS select it instead of the installed copy.
fs.rmSync(builtApp, { recursive: true, force: true });
run('open', ['-a', installedApp]);
console.log(`SkillCue ${JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version} opened: ${installedApp}`);
