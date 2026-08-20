import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyReleaseMetadata } from './verify_release_metadata.mjs';

async function fixture({ version = '0.0.38', notes = version, changelog = version } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'skillcue-release-metadata-'));
  await mkdir(path.join(root, 'apps', 'desktop', 'src', 'lib'), { recursive: true });
  await writeFile(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ version }));
  await writeFile(
    path.join(root, 'apps', 'desktop', 'src', 'lib', 'releaseNotes.ts'),
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
