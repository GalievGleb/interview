import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationalTelemetryStore } from './operationalTelemetry';

const dirs: string[] = [];
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillcue-telemetry-'));
  dirs.push(dir);
  return new OperationalTelemetryStore(dir, '0.0.38-dev');
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('privacy-safe operational telemetry', () => {
  it('is disabled by default and records nothing', () => {
    const telemetry = store();
    telemetry.record({ category: 'overlay', code: 'provider_unavailable', count: 1 });
    expect(telemetry.snapshot()).toEqual({ enabled: false, events: [] });
  });

  it('stores only allowlisted aggregate fields', () => {
    const telemetry = store();
    telemetry.setEnabled(true);
    telemetry.record({
      category: 'hh', code: 'retry', count: 2,
      cookie: 'secret', resume: 'private', transcript: 'private', answer: 'private',
    } as never);
    const serialized = JSON.stringify(telemetry.snapshot());
    expect(serialized).toContain('"code":"retry"');
    expect(serialized).not.toMatch(/secret|private|cookie|resume|transcript|answer/i);
  });

  it('keeps only the latest 200 aggregate events', () => {
    const telemetry = store();
    telemetry.setEnabled(true);
    for (let index = 0; index < 205; index++) {
      telemetry.record({ category: 'app', code: `event_${index}`, count: 1 });
    }
    expect(telemetry.snapshot().events).toHaveLength(200);
    expect(telemetry.snapshot().events[0]?.code).toBe('event_5');
  });
});
