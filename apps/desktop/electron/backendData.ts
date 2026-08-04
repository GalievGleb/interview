import fs from 'fs';
import path from 'path';

const DATABASE_NAME = 'copilot.sqlite';
const SQLITE_SIDECARS = ['', '-wal', '-shm'] as const;

function legacyDatabaseCandidates(resourcesPath: string): string[] {
  return [
    path.join(resourcesPath, 'backend', '_internal', 'data', DATABASE_NAME),
    path.join(resourcesPath, 'backend', 'data', DATABASE_NAME),
  ];
}

export function preparePersistentBackendData(
  userDataPath: string,
  resourcesPath: string,
): string {
  const persistentDir = path.join(userDataPath, 'backend-data');
  const destination = path.join(persistentDir, DATABASE_NAME);
  fs.mkdirSync(persistentDir, { recursive: true });

  if (fs.existsSync(destination)) return destination;

  const legacy = legacyDatabaseCandidates(resourcesPath).find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!legacy) return destination;

  for (const suffix of SQLITE_SIDECARS) {
    const source = `${legacy}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${destination}${suffix}`);
  }
  return destination;
}

export function sqliteDatabaseUrl(databasePath: string): string {
  return `sqlite:///${databasePath.replace(/\\/g, '/')}`;
}
