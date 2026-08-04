import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preparePersistentBackendData, sqliteDatabaseUrl } from './backendData';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-backend-data-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('persistent packaged backend data', () => {
  it('migrates the legacy bundled database on first launch', () => {
    const root = tempRoot();
    const resources = path.join(root, 'resources');
    const userData = path.join(root, 'user-data');
    const legacyDir = path.join(resources, 'backend', '_internal', 'data');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'copilot.sqlite'), 'resume-and-history');
    fs.writeFileSync(path.join(legacyDir, 'copilot.sqlite-wal'), 'pending-wal');

    const databasePath = preparePersistentBackendData(userData, resources);

    expect(fs.readFileSync(databasePath, 'utf8')).toBe('resume-and-history');
    expect(fs.readFileSync(`${databasePath}-wal`, 'utf8')).toBe('pending-wal');
    expect(databasePath).toBe(path.join(userData, 'backend-data', 'copilot.sqlite'));
  });

  it('never overwrites a persistent database on later launches or reinstalls', () => {
    const root = tempRoot();
    const resources = path.join(root, 'resources');
    const userData = path.join(root, 'user-data');
    const legacyDir = path.join(resources, 'backend', '_internal', 'data');
    const persistentDir = path.join(userData, 'backend-data');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(persistentDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'copilot.sqlite'), 'installer-copy');
    fs.writeFileSync(path.join(persistentDir, 'copilot.sqlite'), 'user-copy');

    const databasePath = preparePersistentBackendData(userData, resources);

    expect(fs.readFileSync(databasePath, 'utf8')).toBe('user-copy');
  });

  it('builds a SQLAlchemy-compatible Windows sqlite URL', () => {
    expect(sqliteDatabaseUrl('C:\\Users\\Me\\SkillCue Data\\copilot.sqlite')).toBe(
      'sqlite:///C:/Users/Me/SkillCue Data/copilot.sqlite',
    );
  });
});
