import { describe, expect, it } from 'vitest';
import { readinessFailureCopy } from './liveReadinessNotification';

describe('live readiness system warning', () => {
  it('maps only allowlisted failure codes to customer-safe copy', () => {
    expect(readinessFailureCopy('provider_unavailable')).toEqual({
      title: 'SkillCue требует внимания до созвона',
      body: 'Онлайн-ИИ сейчас не отвечает. Откройте SkillCue заранее и проверьте тариф или подключение.',
    });
    expect(readinessFailureCopy('secret=sk-test')).toBeNull();
  });
});
