import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { expect, it } from 'vitest';

it('packages a working account endpoint without requiring a shell variable', () => {
  const filename = path.resolve(__dirname, '../electron-builder.alpha.cjs');
  const realRequire = createRequire(filename);
  const module = { exports: {} as { extraMetadata?: { accountApiUrl?: string } } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    __dirname: path.dirname(filename),
    process: { env: { GITHUB_SHA: '123456789' } },
    require: (id: string) => id === './build/googleOAuthMetadata.cjs'
      ? { loadGoogleOAuthMetadata: () => ({ googleOAuthClientId: 'test', googleOAuthClientSecret: 'test' }) }
      : realRequire(id),
  });
  expect(module.exports.extraMetadata?.accountApiUrl).toBe('https://skill-cue.ru/account');
});
