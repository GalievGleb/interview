import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BackupService } from './backupService';

function temporaryWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-backup-'));
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  return { root, userData, backup: path.join(root, 'profile.skillcue-backup') };
}

describe('SkillCue local backup', () => {
  it('writes a versioned, checksummed backup without account credentials', () => {
    const paths = temporaryWorkspace();
    fs.writeFileSync(path.join(paths.userData, 'main-settings.json'), '{"theme":"dark"}');
    fs.writeFileSync(path.join(paths.userData, 'account-session.json'), 'private-refresh-token');
    const service = new BackupService(paths.userData, () => new Date('2026-09-13T00:00:00.000Z'));

    const result = service.exportTo(paths.backup, {
      'skillcue.growth-profile.v1': '{"role":"QA"}',
    });

    const raw = zlib.gunzipSync(fs.readFileSync(paths.backup)).toString('utf8');
    expect(result.manifestVersion).toBe(1);
    expect(raw).toContain('main-settings.json');
    expect(raw).toContain('skillcue.growth-profile.v1');
    expect(raw).not.toContain('private-refresh-token');
    expect(raw).not.toContain('account-session.json');
  });

  it('rejects corrupt archives and entries that escape the SkillCue data directory', () => {
    const paths = temporaryWorkspace();
    const service = new BackupService(paths.userData);
    fs.writeFileSync(paths.backup, 'not-a-backup');
    expect(() => service.preview(paths.backup)).toThrow('BACKUP_INVALID');

    const content = Buffer.from('escape');
    const malicious = {
      manifest: {
        version: 1, createdAt: new Date().toISOString(),
        files: [{ path: '../outside.txt', size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') }],
      },
      files: { '../outside.txt': content.toString('base64') },
      rendererStorage: {},
    };
    fs.writeFileSync(paths.backup, zlib.gzipSync(JSON.stringify(malicious)));
    expect(() => service.preview(paths.backup)).toThrow('BACKUP_PATH_INVALID');
  });

  it('validates checksums before changing anything', () => {
    const paths = temporaryWorkspace();
    const service = new BackupService(paths.userData);
    const archive = {
      manifest: {
        version: 1, createdAt: new Date().toISOString(),
        files: [{ path: 'main-settings.json', size: 3, sha256: 'wrong' }],
      },
      files: { 'main-settings.json': Buffer.from('new').toString('base64') },
      rendererStorage: {},
    };
    fs.writeFileSync(paths.backup, zlib.gzipSync(JSON.stringify(archive)));
    expect(() => service.preview(paths.backup)).toThrow('BACKUP_CHECKSUM_INVALID');
    expect(fs.existsSync(path.join(paths.userData, 'main-settings.json'))).toBe(false);
  });

  it('creates a rollback backup before an explicit import overwrites local data', () => {
    const paths = temporaryWorkspace();
    fs.writeFileSync(path.join(paths.userData, 'main-settings.json'), 'old');
    const service = new BackupService(paths.userData, () => new Date('2026-09-13T00:00:00.000Z'));
    service.exportTo(paths.backup, { 'skillcue.theme': 'light' });
    fs.writeFileSync(path.join(paths.userData, 'main-settings.json'), 'changed-after-export');

    const applied = service.apply(paths.backup, { 'skillcue.theme': 'dark' });

    expect(fs.readFileSync(path.join(paths.userData, 'main-settings.json'), 'utf8')).toBe('old');
    expect(fs.existsSync(applied.rollbackPath)).toBe(true);
    expect(applied.rendererStorage).toEqual({ 'skillcue.theme': 'light' });
    const rollback = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(applied.rollbackPath)).toString('utf8'),
    ) as { rendererStorage: Record<string, string> };
    expect(rollback.rendererStorage).toEqual({ 'skillcue.theme': 'dark' });
  });
});
