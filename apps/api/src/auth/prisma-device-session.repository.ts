import { PrismaService } from '../prisma/prisma.service';
import type { DeviceSessionRecord, DeviceSessionRepository } from './device-session.service';

export class PrismaDeviceSessionRepository implements DeviceSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  listActive(userId: string): Promise<DeviceSessionRecord[]> {
    return this.prisma.deviceSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  findByInstallation(userId: string, installationHash: string): Promise<DeviceSessionRecord | null> {
    return this.prisma.deviceSession.findFirst({ where: { userId, installationHash, revokedAt: null } });
  }

  findById(id: string): Promise<DeviceSessionRecord | null> {
    return this.prisma.deviceSession.findUnique({ where: { id } });
  }

  async createIfBelowLimit(record: DeviceSessionRecord, limit: number): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`skillcue-device:${record.userId}`}))`;
      const active = await tx.deviceSession.count({
        where: { userId: record.userId, revokedAt: null },
      });
      if (active >= limit) return false;
      await tx.deviceSession.create({ data: record });
      return true;
    });
  }

  async rotate(id: string, refreshTokenHash: string, seenAt: Date, deviceName?: string): Promise<void> {
    await this.prisma.deviceSession.update({
      where: { id },
      data: { refreshTokenHash, lastSeenAt: seenAt, ...(deviceName ? { deviceName } : {}) },
    });
  }

  async rotateIfCurrent(
    id: string,
    currentRefreshTokenHash: string,
    nextRefreshTokenHash: string,
    seenAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.deviceSession.updateMany({
      where: { id, refreshTokenHash: currentRefreshTokenHash, revokedAt: null },
      data: { refreshTokenHash: nextRefreshTokenHash, lastSeenAt: seenAt },
    });
    return result.count === 1;
  }

  async revoke(userId: string, id: string, revokedAt: Date): Promise<void> {
    await this.prisma.deviceSession.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt },
    });
  }

  async revokeAll(userId: string, revokedAt: Date): Promise<void> {
    await this.prisma.deviceSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
  }
}
