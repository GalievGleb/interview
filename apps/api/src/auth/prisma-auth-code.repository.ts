import { EmailChallengePurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AuthCodePurpose,
  AuthCodeRecord,
  AuthCodeRepository,
} from './auth-code.service';

const toPrismaPurpose = (purpose: AuthCodePurpose): EmailChallengePurpose =>
  purpose === 'verify_email'
    ? EmailChallengePurpose.VERIFY_EMAIL
    : EmailChallengePurpose.RESET_PASSWORD;

const fromPrismaRecord = (record: {
  id: string;
  email: string;
  purpose: EmailChallengePurpose;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
}): AuthCodeRecord => ({
  ...record,
  purpose: record.purpose === EmailChallengePurpose.VERIFY_EMAIL
    ? 'verify_email'
    : 'reset_password',
});

export class PrismaAuthCodeRepository implements AuthCodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  countRecent(email: string, purpose: AuthCodePurpose, since: Date): Promise<number> {
    return this.prisma.emailChallenge.count({
      where: { email, purpose: toPrismaPurpose(purpose), createdAt: { gte: since } },
    });
  }

  async replace(record: AuthCodeRecord): Promise<void> {
    const purpose = toPrismaPurpose(record.purpose);
    await this.prisma.$transaction([
      this.prisma.emailChallenge.updateMany({
        where: { email: record.email, purpose, consumedAt: null },
        data: { consumedAt: record.createdAt },
      }),
      this.prisma.emailChallenge.create({
        data: {
          id: record.id,
          email: record.email,
          purpose,
          codeHash: record.codeHash,
          expiresAt: record.expiresAt,
          attempts: record.attempts,
          consumedAt: record.consumedAt,
          createdAt: record.createdAt,
        },
      }),
    ]);
  }

  async findActive(email: string, purpose: AuthCodePurpose): Promise<AuthCodeRecord | null> {
    const record = await this.prisma.emailChallenge.findFirst({
      where: { email, purpose: toPrismaPurpose(purpose), consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return record ? fromPrismaRecord(record) : null;
  }

  async incrementAttempts(id: string, consume: boolean): Promise<void> {
    await this.prisma.emailChallenge.update({
      where: { id },
      data: {
        attempts: { increment: 1 },
        ...(consume ? { consumedAt: new Date() } : {}),
      },
    });
  }

  async consume(id: string): Promise<void> {
    await this.prisma.emailChallenge.update({ where: { id }, data: { consumedAt: new Date() } });
  }

  async consumeIfActive(id: string): Promise<boolean> {
    const result = await this.prisma.emailChallenge.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return result.count === 1;
  }

  async remove(id: string): Promise<void> {
    await this.prisma.emailChallenge.deleteMany({ where: { id } });
  }
}
