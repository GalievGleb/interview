import { describe, expect, it } from 'vitest';
import { describeUpdateError, unsupportedUpdateMessage } from './updateError';

describe('safe update errors', () => {
  it.each(['net::ERR_NAME_NOT_RESOLVED', 'getaddrinfo ENOTFOUND github.com'])(
    'explains DNS failure without exposing request details (%s)', (message) => {
      const result = describeUpdateError(new Error(message));
      expect(result).toMatch(/адрес сервера/iu);
      expect(result).toMatch(/повтор/iu);
    },
  );
  it('explains timeout as a retryable download/check failure', () => {
    expect(describeUpdateError(new Error('ETIMEDOUT'))).toMatch(/время ожидания/iu);
  });
  it('does not offer to run a corrupted installer', () => {
    expect(describeUpdateError(new Error('sha512 checksum mismatch'))).toMatch(/поврежд[её]н/iu);
    expect(describeUpdateError(new Error('sha512 checksum mismatch'))).toMatch(/заново/iu);
  });
  it('offers the official site when the update manifest is absent', () => {
    expect(describeUpdateError(new Error('Cannot find latest.yml: 404'))).toMatch(/сайта/iu);
  });
  it.each([
    new Error('unknown failure https://example.test/file?token=PRIVATE_SECRET'),
    { message: 'PRIVATE_SECRET', code: 'unexpected' },
    'PRIVATE_SECRET',
  ])('never reflects unknown exceptions or secrets into the UI', (error) => {
    const result = describeUpdateError(error);
    expect(result).not.toContain('PRIVATE_SECRET');
    expect(result).not.toContain('example.test');
    expect(result).toMatch(/повтор/iu);
  });
  it('identifies the manual Alpha channel instead of mislabelling it as Dev', () => {
    const result = unsupportedUpdateMessage('alpha');
    expect(result).toContain('SkillCue Alpha');
    expect(result).not.toContain('SkillCue Dev');
    expect(result).toMatch(/установщик/iu);
  });
  it('does not offer a public Stable installer as a Dev update', () => {
    expect(unsupportedUpdateMessage('dev')).toMatch(/SkillCue Dev.*отдельный установщик/iu);
  });
});
