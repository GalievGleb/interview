import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeviceLimitError,
  DeviceSessionError,
  DeviceSessionService,
  type DeviceSessionRecord,
  type DeviceSessionRepository,
} from './device-session.service';

class MemorySessions implements DeviceSessionRepository {
  rows: DeviceSessionRecord[] = [];

  async listActive(userId: string) {
    return this.rows.filter((row) => row.userId === userId && !row.revokedAt).map((row) => ({ ...row }));
  }
  async findByInstallation(userId: string, installationHash: string) {
    const row = this.rows.find((item) => item.userId === userId && item.installationHash === installationHash && !item.revokedAt);
    return row ? { ...row } : null;
  }
  async findById(id: string) {
    const row = this.rows.find((item) => item.id === id);
    return row ? { ...row } : null;
  }
  async createIfBelowLimit(record: DeviceSessionRecord, limit: number) {
    if (this.rows.filter((row) => row.userId === record.userId && !row.revokedAt).length >= limit) return false;
    this.rows.push({ ...record });
    return true;
  }
  async rotate(id: string, refreshTokenHash: string, seenAt: Date, deviceName?: string) {
    const row = this.rows.find((item) => item.id === id);
    if (!row) return;
    row.refreshTokenHash = refreshTokenHash;
    row.lastSeenAt = seenAt;
    if (deviceName) row.deviceName = deviceName;
  }
  async rotateIfCurrent(id: string, currentHash: string, nextHash: string, seenAt: Date) {
    const row = this.rows.find((item) => item.id === id && !item.revokedAt);
    if (!row || row.refreshTokenHash !== currentHash) return false;
    row.refreshTokenHash = nextHash;
    row.lastSeenAt = seenAt;
    return true;
  }
  async revoke(userId: string, id: string, revokedAt: Date) {
    const row = this.rows.find((item) => item.userId === userId && item.id === id);
    if (row) row.revokedAt = revokedAt;
  }
  async revokeAll(userId: string, revokedAt: Date) {
    for (const row of this.rows) if (row.userId === userId && !row.revokedAt) row.revokedAt = revokedAt;
  }
}

function fixture() {
  const repository = new MemorySessions();
  let sequence = 0;
  let tokenSequence = 0;
  const service = new DeviceSessionService(repository, {
    deviceSecret: 'device-secret-which-is-at-least-32-characters',
    now: () => new Date('2026-09-13T00:00:00.000Z'),
    randomId: () => `session-${++sequence}`,
    randomToken: () => `random-token-${++tokenSequence}`,
  });
  return { repository, service };
}

test('opens sessions for two different installations and rejects a third', async () => {
  const { service } = fixture();
  const first = await service.open('user-1', 'installation-111111', 'Рабочий ПК');
  const second = await service.open('user-1', 'installation-222222', 'Ноутбук');

  assert.match(first.refreshToken, /^session-1\./);
  assert.match(second.refreshToken, /^session-2\./);
  await assert.rejects(
    () => service.open('user-1', 'installation-333333', 'ПК друга'),
    (error: unknown) => error instanceof DeviceLimitError && error.devices.length === 2,
  );
});

test('signing in again on the same installation rotates instead of consuming a slot', async () => {
  const { repository, service } = fixture();
  const first = await service.open('user-1', 'installation-111111', 'ПК');
  const again = await service.open('user-1', 'installation-111111', 'Переименованный ПК');

  assert.equal(again.sessionId, first.sessionId);
  assert.notEqual(again.refreshToken, first.refreshToken);
  assert.equal(repository.rows.length, 1);
  assert.equal(repository.rows[0].deviceName, 'Переименованный ПК');
});

test('refresh tokens rotate and an old token cannot be reused', async () => {
  const { service } = fixture();
  const opened = await service.open('user-1', 'installation-111111', 'ПК');
  const refreshed = await service.refresh(opened.refreshToken);

  assert.equal(refreshed.userId, 'user-1');
  assert.notEqual(refreshed.refreshToken, opened.refreshToken);
  await assert.rejects(
    () => service.refresh(opened.refreshToken),
    (error: unknown) => error instanceof DeviceSessionError && error.code === 'SESSION_INVALID',
  );
});

test('two concurrent uses of one refresh token produce only one new session token', async () => {
  const { service } = fixture();
  const opened = await service.open('user-1', 'installation-111111', 'ПК');

  const results = await Promise.allSettled([
    service.refresh(opened.refreshToken),
    service.refresh(opened.refreshToken),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('revoking a device invalidates its refresh token and frees one slot', async () => {
  const { service } = fixture();
  const first = await service.open('user-1', 'installation-111111', 'ПК');
  await service.open('user-1', 'installation-222222', 'Ноутбук');

  await service.revoke('user-1', first.sessionId);
  await assert.rejects(() => service.refresh(first.refreshToken), DeviceSessionError);
  const replacement = await service.open('user-1', 'installation-333333', 'Новый ПК');
  assert.match(replacement.refreshToken, /^session-3\./);
});

test('stored session data contains hashes rather than raw installation ids or refresh tokens', async () => {
  const { repository, service } = fixture();
  const opened = await service.open('user-1', 'installation-111111', 'ПК');
  const serialized = JSON.stringify(repository.rows);

  assert.equal(serialized.includes('installation-111111'), false);
  assert.equal(serialized.includes(opened.refreshToken), false);
});

test('concurrent sign-ins cannot race past the two-device cap', async () => {
  const { repository, service } = fixture();
  await service.open('user-1', 'installation-111111', 'Первый ПК');

  const results = await Promise.allSettled([
    service.open('user-1', 'installation-222222', 'Второй ПК'),
    service.open('user-1', 'installation-333333', 'Третий ПК'),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(repository.rows.filter((row) => !row.revokedAt).length, 2);
});
