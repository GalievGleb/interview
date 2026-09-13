import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BACKUP_VERSION = 1 as const;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const ALLOWED_FILES = new Set([
  'backend-data/copilot.sqlite',
  'backend-data/copilot.sqlite-wal',
  'backend-data/copilot.sqlite-shm',
  'hh-browser-assistant.json',
  'hh-chat-browser.json',
  'interview-calendar.json',
  'main-settings.json',
]);

const ALLOWED_RENDERER_KEYS = new Set([
  'skillcue.lang',
  'skillcue.theme',
  'skillcue.answerLanguage',
  'skillcue.answerModes',
  'skillcue.answerMode',
  'skillcue.candidate-path.v1',
  'skillcue.growth-profile.v1',
  'skillcue.hhHrProfileDrafts.v1',
  'skillcue.prepare.draft.v1',
  'skillcue.prepare.resume-source',
  'skillcue.vacancyReview.sessions.v1',
  'skillcue.vacancyReview.deleted.v1',
  'skillcue:session-knowledge:v1',
  'skillcue:session-knowledge-epoch:v1',
  'copilot-live-prefs',
  'fast-answer',
  'skillcue.answerChime',
  'skillcue.overlaySmart',
  'skillcue.overlayStealth',
  'skillcue.overlayAvoidFocus',
  'skillcue.overlayUseScreen',
  'skillcue.overlayHideWidget',
  'skillcue.overlayOpacity',
  'skillcue.overlayQuickGuideSeen.v1',
  'skillcue.skipTaskbar',
  'skillcue.sidebarCollapsed',
]);

interface BackupManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface BackupArchive {
  manifest: {
    version: number;
    createdAt: string;
    files: BackupManifestFile[];
  };
  files: Record<string, string>;
  rendererStorage: Record<string, string>;
}

export class BackupService {
  constructor(
    private readonly userDataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  exportTo(destination: string, rendererStorage: Record<string, string>) {
    const files: Record<string, string> = {};
    const manifestFiles: BackupManifestFile[] = [];
    let totalBytes = 0;
    for (const relative of ALLOWED_FILES) {
      const source = this.safeTarget(relative);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const content = fs.readFileSync(source);
      if (content.length > MAX_FILE_BYTES) throw new Error('BACKUP_TOO_LARGE');
      totalBytes += content.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('BACKUP_TOO_LARGE');
      files[relative] = content.toString('base64');
      manifestFiles.push({
        path: relative,
        size: content.length,
        sha256: sha256(content),
      });
    }

    const safeRendererStorage = Object.fromEntries(
      Object.entries(rendererStorage)
        .filter(([key, value]) => ALLOWED_RENDERER_KEYS.has(key) && typeof value === 'string')
        .map(([key, value]) => [key, value.slice(0, 5_000_000)]),
    );
    const archive: BackupArchive = {
      manifest: {
        version: BACKUP_VERSION,
        createdAt: this.now().toISOString(),
        files: manifestFiles,
      },
      files,
      rendererStorage: safeRendererStorage,
    };
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, zlib.gzipSync(JSON.stringify(archive), { level: 9 }), { mode: 0o600 });
    return {
      path: destination,
      manifestVersion: BACKUP_VERSION,
      fileCount: manifestFiles.length,
      rendererKeyCount: Object.keys(safeRendererStorage).length,
      createdAt: archive.manifest.createdAt,
    };
  }

  preview(source: string) {
    const archive = this.readAndValidate(source);
    return {
      manifestVersion: BACKUP_VERSION,
      createdAt: archive.manifest.createdAt,
      fileCount: archive.manifest.files.length,
      rendererKeyCount: Object.keys(archive.rendererStorage).length,
    };
  }

  apply(source: string, currentRendererStorage: Record<string, string> = {}) {
    const archive = this.readAndValidate(source);
    const rollbackDir = path.join(this.userDataDir, 'backups');
    const stamp = this.now().toISOString().replace(/[:.]/gu, '-');
    const rollbackPath = path.join(rollbackDir, `rollback-${stamp}.skillcue-backup`);
    this.exportTo(rollbackPath, currentRendererStorage);

    for (const entry of archive.manifest.files) {
      const target = this.safeTarget(entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(archive.files[entry.path], 'base64'), { mode: 0o600 });
    }
    return { rollbackPath, rendererStorage: archive.rendererStorage };
  }

  private readAndValidate(source: string): BackupArchive {
    let archive: BackupArchive;
    try {
      const compressed = fs.readFileSync(source);
      if (compressed.length > MAX_TOTAL_BYTES) throw new Error('BACKUP_TOO_LARGE');
      archive = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: MAX_TOTAL_BYTES }).toString('utf8')) as BackupArchive;
    } catch (error) {
      if (error instanceof Error && error.message === 'BACKUP_TOO_LARGE') throw error;
      throw new Error('BACKUP_INVALID', { cause: error });
    }

    if (
      archive?.manifest?.version !== BACKUP_VERSION ||
      !Array.isArray(archive.manifest.files) ||
      !archive.files || typeof archive.files !== 'object' ||
      !archive.rendererStorage || typeof archive.rendererStorage !== 'object' ||
      Number.isNaN(Date.parse(archive.manifest.createdAt))
    ) throw new Error('BACKUP_INVALID');

    let totalBytes = 0;
    const listed = new Set<string>();
    for (const entry of archive.manifest.files) {
      if (!entry || typeof entry.path !== 'string' || !ALLOWED_FILES.has(entry.path)) {
        throw new Error('BACKUP_PATH_INVALID');
      }
      this.safeTarget(entry.path);
      if (listed.has(entry.path)) throw new Error('BACKUP_INVALID');
      listed.add(entry.path);
      const encoded = archive.files[entry.path];
      if (typeof encoded !== 'string') throw new Error('BACKUP_INVALID');
      const content = Buffer.from(encoded, 'base64');
      totalBytes += content.length;
      if (
        content.length !== entry.size || content.length > MAX_FILE_BYTES ||
        totalBytes > MAX_TOTAL_BYTES || sha256(content) !== entry.sha256
      ) throw new Error('BACKUP_CHECKSUM_INVALID');
    }
    if (Object.keys(archive.files).some((file) => !listed.has(file))) throw new Error('BACKUP_INVALID');
    for (const [key, value] of Object.entries(archive.rendererStorage)) {
      if (!ALLOWED_RENDERER_KEYS.has(key) || typeof value !== 'string' || value.length > 5_000_000) {
        throw new Error('BACKUP_RENDERER_DATA_INVALID');
      }
    }
    return archive;
  }

  private safeTarget(relative: string): string {
    const normalized = relative.replace(/\\/gu, '/');
    if (
      path.isAbsolute(relative) || normalized.startsWith('/') ||
      normalized.split('/').some((part) => !part || part === '.' || part === '..')
    ) throw new Error('BACKUP_PATH_INVALID');
    const root = path.resolve(this.userDataDir);
    const target = path.resolve(root, ...normalized.split('/'));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('BACKUP_PATH_INVALID');
    return target;
  }
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function rendererBackupKeys(): string[] {
  return [...ALLOWED_RENDERER_KEYS];
}
