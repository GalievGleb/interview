import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api-py');
const venvPython = path.join(backendDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: backendDir, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!fs.existsSync(venvPython)) {
  const python = process.env.SKILLCUE_PYTHON?.trim();
  if (python) {
    run(python, ['-m', 'venv', '.venv']);
  } else if (process.platform === 'win32') {
    run('py', ['-3.12', '-m', 'venv', '.venv']);
  } else {
    run('python3.12', ['-m', 'venv', '.venv']);
  }
}

// uv-created virtual environments may not include pip.
const pip = spawnSync(venvPython, ['-m', 'pip', '--version'], { cwd: backendDir, stdio: 'ignore' });
if (pip.status !== 0) run(venvPython, ['-m', 'ensurepip', '--upgrade']);

run(venvPython, ['-m', 'pip', 'install', '-r', 'requirements.txt', 'pyinstaller']);
run(venvPython, ['-m', 'PyInstaller', '-y', 'skillcue-backend.spec']);
