import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('backup IPC lifecycle', () => {
  it('stops SQLite writes while exporting and always restarts the backend', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    const start = source.indexOf("handle('backup:export'");
    const end = source.indexOf("handle('backup:preview'", start);
    const handler = source.slice(start, end);

    expect(handler.indexOf('await stopBackendForBackupImport()')).toBeGreaterThan(0);
    expect(handler.indexOf('backupService.exportTo')).toBeGreaterThan(
      handler.indexOf('await stopBackendForBackupImport()'),
    );
    expect(handler).toContain('ensureBackend()');
  });
});
