import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyReleaseMetadata } from './verify_release_metadata.mjs';

async function fixture({
  version = '0.0.38',
  notes = version,
  changelog = version,
  rootVersion = version,
  apiVersion = version,
  sharedVersion = version,
  pythonVersion = version,
  fastApiVersion = version,
  notesSource,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillcue-release-metadata-'));
  await mkdir(path.join(root, 'apps', 'desktop', 'src', 'lib'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'api'), { recursive: true });
  await mkdir(path.join(root, 'apps', 'api-py', 'app'), { recursive: true });
  await mkdir(path.join(root, 'packages', 'shared'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: rootVersion }));
  await writeFile(path.join(root, 'apps', 'api', 'package.json'), JSON.stringify({ version: apiVersion }));
  await writeFile(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ version }));
  await writeFile(
    path.join(root, 'packages', 'shared', 'package.json'),
    JSON.stringify({ version: sharedVersion }),
  );
  await writeFile(
    path.join(root, 'apps', 'api-py', 'pyproject.toml'),
    `[project]\nname = "skillcue-api"\nversion = "${pythonVersion}"\n`,
  );
  await writeFile(
    path.join(root, 'apps', 'api-py', 'app', 'main.py'),
    `app = FastAPI(title="SkillCue API", version="${fastApiVersion}")\n` +
      `return {"status": "ok", "version": "${fastApiVersion}"}\n`,
  );
  await writeFile(
    path.join(root, 'apps', 'desktop', 'src', 'lib', 'releaseNotes.ts'),
    notesSource ??
      `export const RELEASE_NOTES = [{ version: '${notes}', date: '2026-08-20', title: 'Release', points: [] }];`,
  );
  await writeFile(path.join(root, 'CHANGELOG.md'), `## [${changelog}] - 2026-08-20\n`);
  return root;
}

test('accepts matching stable tag, package, notes, and changelog', async () => {
  const root = await fixture();
  assert.deepEqual(await verifyReleaseMetadata({ root, tag: 'v0.0.38' }), { version: '0.0.38' });
});

test('rejects a dev package behind a stable public tag', async () => {
  const root = await fixture({ version: '0.0.38-dev', notes: '0.0.38' });
  await assert.rejects(
    verifyReleaseMetadata({ root, tag: 'v0.0.38' }),
    /stable semantic version.*0\.0\.38-dev/i,
  );
});

test('rejects a tag that does not match release metadata', async () => {
  const root = await fixture({ version: '0.0.38', notes: '0.0.38', changelog: '0.0.38' });
  await assert.rejects(
    verifyReleaseMetadata({ root, tag: 'v0.0.39' }),
    /tag v0\.0\.39 does not match package version 0\.0\.38/i,
  );
});

test('rejects a workspace package version that differs from the desktop release', async () => {
  const root = await fixture({ version: '0.1.0', apiVersion: '0.0.40' });
  await assert.rejects(
    verifyReleaseMetadata({ root, tag: 'v0.1.0' }),
    /apps\/api\/package\.json version 0\.0\.40 does not match desktop version 0\.1\.0/i,
  );
});

test('rejects a Python package version that differs from the desktop release', async () => {
  const root = await fixture({ version: '0.1.0', pythonVersion: '0.0.40' });
  await assert.rejects(
    verifyReleaseMetadata({ root, tag: 'v0.1.0' }),
    /apps\/api-py\/pyproject\.toml version 0\.0\.40 does not match desktop version 0\.1\.0/i,
  );
});

test('rejects a FastAPI version that differs from the desktop release', async () => {
  const root = await fixture({ version: '0.1.0', fastApiVersion: '0.0.40' });
  await assert.rejects(
    verifyReleaseMetadata({ root, tag: 'v0.1.0' }),
    /apps\/api-py\/app\/main\.py version 0\.0\.40 does not match desktop version 0\.1\.0/i,
  );
});

test('rejects duplicate in-app notes for the release version', async () => {
  const root = await fixture({
    version: '0.1.0',
    notesSource:
      "export const RELEASE_NOTES = [{ version: '0.1.0' }, { version: '0.1.0' }];",
  });
  await assert.rejects(
    verifyReleaseMetadata({ root, tag: 'v0.1.0' }),
    /release notes contain 2 entries for version 0\.1\.0/i,
  );
});
