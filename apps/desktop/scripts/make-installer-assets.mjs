import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.SKILLCUE_PYTHON?.trim() || (process.platform === 'win32' ? 'py' : 'python3');
const args = process.env.SKILLCUE_PYTHON || process.platform !== 'win32'
  ? ['build/make_icon.py']
  : ['-3.12', 'build/make_icon.py'];
const result = spawnSync(python, args, { cwd: desktopDir, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
