import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { SubscriptionGuard } from './subscription.guard';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { MailModule } from '../mail/mail.module';
import { ResendMailClient } from '../mail/resend-mail.client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthCodeService } from './auth-code.service';
import { PrismaAuthCodeRepository } from './prisma-auth-code.repository';
import { DeviceSessionService } from './device-session.service';
import { PrismaDeviceSessionRepository } from './prisma-device-session.repository';
import { GoogleIdentityService, GoogleOAuthVerifier } from './google-identity.service';
import { PrismaGoogleIdentityRepository } from './prisma-google-identity.repository';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    SubscriptionsModule,
    MailModule,
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: AuthCodeService,
      inject: [PrismaService, ResendMailClient],
      useFactory: (prisma: PrismaService, mailer: ResendMailClient) =>
        new AuthCodeService(
          new PrismaAuthCodeRepository(prisma),
          mailer,
          { secret: process.env.AUTH_CODE_SECRET ?? '' },
        ),
    },
    {
      provide: DeviceSessionService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new DeviceSessionService(
          new PrismaDeviceSessionRepository(prisma),
          { deviceSecret: process.env.DEVICE_ID_SECRET ?? '' },
        ),
    },
    {
      provide: GoogleIdentityService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new GoogleIdentityService(
        new GoogleOAuthVerifier(),
        new PrismaGoogleIdentityRepository(prisma),
        { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '' },
      ),
    },
    AuthService,
    JwtStrategy,
    SubscriptionGuard,
  ],
  exports: [AuthService, DeviceSessionService, GoogleIdentityService, SubscriptionGuard, JwtModule, PassportModule],
})
export class AuthModule {}
