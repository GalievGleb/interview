import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

export async function verifyReleaseMetadata({ root, tag }) {
  const packagePath = path.join(root, 'apps', 'desktop', 'package.json');
  const notesPath = path.join(root, 'apps', 'desktop', 'src', 'lib', 'releaseNotes.ts');
  const changelogPath = path.join(root, 'CHANGELOG.md');
  const [packageText, notes, changelog] = await Promise.all([
    readFile(packagePath, 'utf8'),
    readFile(notesPath, 'utf8'),
    readFile(changelogPath, 'utf8'),
  ]);
  const version = String(JSON.parse(packageText).version ?? '');
  if (!STABLE_VERSION_RE.test(version)) {
    throw new Error(`Desktop package must use a stable semantic version, got ${version || '<empty>'}.`);
  }
  const expectedTag = `v${version}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag ${tag || '<empty>'} does not match package version ${version}.`);
  }
  const firstNote = notes.match(/version:\s*['"]([^'"]+)['"]/i)?.[1];
  if (firstNote !== version) {
    throw new Error(`Top release note ${firstNote || '<missing>'} does not match package version ${version}.`);
  }
  if (!changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG does not contain a ${version} release section.`);
  }
  return { version };
}

async function main() {
  const root = path.resolve(process.argv[2] || '.');
  const tag = process.argv[3] || process.env.GITHUB_REF_NAME || '';
  const result = await verifyReleaseMetadata({ root, tag });
  process.stdout.write(`Release metadata OK: v${result.version}\n`);
}

if (pathToFileURL(process.argv[1] || '').href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
