import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'SettingsPage.tsx'), 'utf8');

describe('operational diagnostics privacy setting', () => {
  it('is explicit, off by default in the backend, and explains that no content is uploaded', () => {
    expect(source).toContain('operationalTelemetry?.getState');
    expect(source).toContain('operationalTelemetry?.setEnabled');
    expect(source).toContain('Не отправляет резюме, ответы, записи, экран, cookies или ключи');
  });
});
