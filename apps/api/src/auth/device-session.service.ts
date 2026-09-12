import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export interface DeviceSessionRecord {
  id: string;
  userId: string;
  installationHash: string;
  deviceName: string;
  refreshTokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface DeviceSessionRepository {
  listActive(userId: string): Promise<DeviceSessionRecord[]>;
  findByInstallation(userId: string, installationHash: string): Promise<DeviceSessionRecord | null>;
  findById(id: string): Promise<DeviceSessionRecord | null>;
  createIfBelowLimit(record: DeviceSessionRecord, limit: number): Promise<boolean>;
  rotate(id: string, refreshTokenHash: string, seenAt: Date, deviceName?: string): Promise<void>;
  rotateIfCurrent(
    id: string,
    currentRefreshTokenHash: string,
    nextRefreshTokenHash: string,
    seenAt: Date,
  ): Promise<boolean>;
  revoke(userId: string, id: string, revokedAt: Date): Promise<void>;
  revokeAll(userId: string, revokedAt: Date): Promise<void>;
}

interface DeviceSessionOptions {
  deviceSecret: string;
  now?: () => Date;
  randomId?: () => string;
  randomToken?: () => string;
}

export class DeviceSessionError extends Error {
  constructor(public readonly code: 'SESSION_INVALID') {
    super(code);
    this.name = 'DeviceSessionError';
  }
}

export class DeviceLimitError extends Error {
  constructor(public readonly devices: DeviceSummary[]) {
    super('DEVICE_LIMIT_REACHED');
    this.name = 'DeviceLimitError';
  }
}

export class DeviceSessionService {
  private readonly options: Required<DeviceSessionOptions>;

  constructor(
    private readonly repository: DeviceSessionRepository,
    options: DeviceSessionOptions,
  ) {
    if (options.deviceSecret.length < 32) {
      throw new Error('DEVICE_ID_SECRET must contain at least 32 characters');
    }
    this.options = {
      deviceSecret: options.deviceSecret,
      now: options.now ?? (() => new Date()),
      randomId: options.randomId ?? randomUUID,
      randomToken: options.randomToken ?? (() => randomBytes(32).toString('base64url')),
    };
  }

  async open(
    userId: string,
    installationId: string,
    deviceName: string,
  ): Promise<{ sessionId: string; refreshToken: string }> {
    const installationHash = this.installationDigest(installationId);
    const existing = await this.repository.findByInstallation(userId, installationHash);
    const now = this.options.now();
    if (existing) {
      const refreshToken = this.makeRefreshToken(existing.id);
      await this.repository.rotate(existing.id, this.tokenDigest(refreshToken), now, cleanDeviceName(deviceName));
      return { sessionId: existing.id, refreshToken };
    }

    const id = this.options.randomId();
    const refreshToken = this.makeRefreshToken(id);
    const created = await this.repository.createIfBelowLimit({
      id,
      userId,
      installationHash,
      deviceName: cleanDeviceName(deviceName),
      refreshTokenHash: this.tokenDigest(refreshToken),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    }, 2);
    if (!created) {
      const active = await this.repository.listActive(userId);
      throw new DeviceLimitError(active.map(toSummary));
    }
    return { sessionId: id, refreshToken };
  }

  async refresh(refreshToken: string): Promise<{ userId: string; sessionId: string; refreshToken: string }> {
    const separator = refreshToken.indexOf('.');
    const id = separator > 0 ? refreshToken.slice(0, separator) : '';
    const record = id ? await this.repository.findById(id) : null;
    if (!record || record.revokedAt || !safeEqual(record.refreshTokenHash, this.tokenDigest(refreshToken))) {
      throw new DeviceSessionError('SESSION_INVALID');
    }
    const rotated = this.makeRefreshToken(record.id);
    const changed = await this.repository.rotateIfCurrent(
      record.id,
      this.tokenDigest(refreshToken),
      this.tokenDigest(rotated),
      this.options.now(),
    );
    if (!changed) throw new DeviceSessionError('SESSION_INVALID');
    return { userId: record.userId, sessionId: record.id, refreshToken: rotated };
  }

  async list(userId: string): Promise<DeviceSummary[]> {
    return (await this.repository.listActive(userId)).map(toSummary);
  }

  async revoke(userId: string, sessionId: string): Promise<void> {
    await this.repository.revoke(userId, sessionId, this.options.now());
  }

  async revokeAll(userId: string): Promise<void> {
    await this.repository.revokeAll(userId, this.options.now());
  }

  private makeRefreshToken(sessionId: string): string {
    return `${sessionId}.${this.options.randomToken()}`;
  }

  private installationDigest(value: string): string {
    return createHmac('sha256', this.options.deviceSecret).update(value).digest('hex');
  }

  private tokenDigest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanDeviceName(value: string): string {
  const clean = value.trim().replace(/\s+/g, ' ').slice(0, 80);
  return clean || 'Устройство SkillCue';
}

function toSummary(record: DeviceSessionRecord): DeviceSummary {
  return {
    id: record.id,
    name: record.deviceName,
    createdAt: record.createdAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
  };
}
