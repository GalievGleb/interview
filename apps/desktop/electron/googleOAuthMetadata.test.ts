import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { loadGoogleOAuthMetadata } = require('../build/googleOAuthMetadata.cjs');
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function config(contents: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-google-config-'));
  directories.push(dir);
  const file = path.join(dir, 'native-client.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return { SKILLCUE_GOOGLE_OAUTH_CONFIG: file };
}

it('packages the matching installed-app OAuth client metadata from local config', () => {
  expect(loadGoogleOAuthMetadata(config({ installed: { client_id: 'client.apps.googleusercontent.com', client_secret: 'native-secret' } }))).toEqual({
    googleOAuthClientId: 'client.apps.googleusercontent.com', googleOAuthClientSecret: 'native-secret',
  });
});
it('refuses web-server credentials and incomplete native config without exposing the secret', () => {
  expect(() => loadGoogleOAuthMetadata(config({ web: { client_secret: 'private-web-secret' } }))).toThrow('Desktop OAuth');
  expect(() => loadGoogleOAuthMetadata(config({ installed: { client_id: 'client', client_secret: '' } }))).toThrow('incomplete');
});
