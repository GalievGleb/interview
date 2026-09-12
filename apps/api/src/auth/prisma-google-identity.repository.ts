import { AuthProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleIdentityRepository } from './google-identity.service';

export class PrismaGoogleIdentityRepository implements GoogleIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  resolve(identity: {
    subject: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  }) {
    return this.prisma.$transaction(async (tx) => {
      // Linking touches two unique keys (Google sub and normalized email).
      // Serialize both before any read/create so concurrent first sign-ins
      // cannot race into a unique violation and abort the transaction.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`skillcue-google-sub:${identity.subject}`}))`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`skillcue-google-email:${identity.email}`}))`;
      const linked = await tx.authIdentity.findUnique({
        where: { provider_subject: { provider: AuthProvider.GOOGLE, subject: identity.subject } },
        include: { user: true },
      });
      if (linked) return linked.user;

      let user = await tx.user.findUnique({ where: { email: identity.email } });
      if (!user) {
        user = await tx.user.create({
          data: {
            email: identity.email,
            passwordHash: null,
            emailVerifiedAt: new Date(),
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl,
          },
        });
      } else {
        user = await tx.user.update({
          where: { id: user.id },
          data: {
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
            displayName: user.displayName ?? identity.displayName,
            avatarUrl: user.avatarUrl ?? identity.avatarUrl,
          },
        });
      }

      await tx.authIdentity.create({
        data: { userId: user.id, provider: AuthProvider.GOOGLE, subject: identity.subject },
      });
      return user;
    });
  }
}
