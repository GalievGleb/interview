import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { EmailCodeDto, GoogleLoginDto, LoginDto, RegisterDto, ResetPasswordDto } from './dto/auth.dto';
import {
  AcceptedResponse,
  AuthResponse,
  PasswordChangedResponse,
  RegistrationPendingResponse,
} from '@interview/shared';
import {
  AuthCodeError,
  AuthCodeService,
  normalizeAccountEmail,
} from './auth-code.service';
import { DeviceLimitError, DeviceSessionService } from './device-session.service';
import { GoogleIdentityService } from './google-identity.service';

/**
 * Fail-closed: never fall back to a hardcoded dev secret. If the environment
 * does not provide a JWT secret, refuse to sign/verify instead of minting
 * forgeable tokens (a known secret in public source = anyone can impersonate).
 */
function accessSecretOrThrow(): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || !secret.length) {
    throw new Error('JWT_ACCESS_SECRET is not configured');
  }
  return secret;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly authCodes: AuthCodeService,
    private readonly deviceSessions: DeviceSessionService,
    private readonly googleIdentities: GoogleIdentityService,
  ) {}

  async register(dto: RegisterDto): Promise<RegistrationPendingResponse> {
    const email = normalizeAccountEmail(dto.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing?.emailVerifiedAt) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash },
      });
    } else {
      await this.prisma.user.create({
        data: { email, passwordHash },
      });
    }
    await this.issueCode(email, 'verify_email');
    return { verificationRequired: true, email };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const email = normalizeAccountEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = user.passwordHash
      ? await bcrypt.compare(dto.password, user.passwordHash)
      : false;
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Email verification required');
    }

    await this.subscriptionsService.claimPending(user.id, user.email);
    const session = await this.openDeviceSession(user.id, dto.deviceId, dto.deviceName);
    return this.buildAuthResponse(user, {
      accessToken: this.issueAccessToken(user.id, user.email, session.sessionId),
      refreshToken: session.refreshToken,
    });
  }

  async loginWithGoogle(dto: GoogleLoginDto): Promise<AuthResponse> {
    let user;
    try {
      user = await this.googleIdentities.resolve(dto.idToken);
    } catch (error) {
      if (error instanceof Error && error.message === 'GOOGLE_OAUTH_CLIENT_ID is not configured') {
        throw error;
      }
      throw new UnauthorizedException('GOOGLE_IDENTITY_INVALID');
    }
    await this.subscriptionsService.claimPending(user.id, user.email);
    const session = await this.openDeviceSession(user.id, dto.deviceId, dto.deviceName);
    return this.buildAuthResponse(user, {
      accessToken: this.issueAccessToken(user.id, user.email, session.sessionId),
      refreshToken: session.refreshToken,
    });
  }

  async verifyEmail(dto: EmailCodeDto): Promise<AuthResponse> {
    const email = normalizeAccountEmail(dto.email);
    await this.verifyCode(email, dto.code, 'verify_email');
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new BadRequestException('CODE_INVALID');
    const verified = await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
    });
    await this.subscriptionsService.claimPending(verified.id, verified.email);
    const session = await this.openDeviceSession(verified.id, dto.deviceId, dto.deviceName);
    return this.buildAuthResponse(verified, {
      accessToken: this.issueAccessToken(verified.id, verified.email, session.sessionId),
      refreshToken: session.refreshToken,
    });
  }

  async requestVerification(rawEmail: string): Promise<AcceptedResponse> {
    const email = normalizeAccountEmail(rawEmail);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt) {
      await this.issueCode(email, 'verify_email');
    }
    return { accepted: true };
  }

  async requestPasswordReset(rawEmail: string): Promise<AcceptedResponse> {
    const email = normalizeAccountEmail(rawEmail);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user?.emailVerifiedAt) {
      await this.issueCode(email, 'reset_password');
    }
    return { accepted: true };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<PasswordChangedResponse> {
    const email = normalizeAccountEmail(dto.email);
    await this.verifyCode(email, dto.code, 'reset_password');
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user?.emailVerifiedAt) throw new BadRequestException('CODE_INVALID');
    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt: new Date(), refreshToken: null },
    });
    await this.deviceSessions.revokeAll(user.id);
    return { changed: true };
  }

  private async verifyCode(
    email: string,
    code: string,
    purpose: 'verify_email' | 'reset_password',
  ): Promise<void> {
    try {
      await this.authCodes.verify(email, code, purpose);
    } catch (error) {
      if (error instanceof AuthCodeError) throw new BadRequestException(error.code);
      throw error;
    }
  }

  private async issueCode(email: string, purpose: 'verify_email' | 'reset_password'): Promise<void> {
    try {
      await this.authCodes.issue(email, purpose);
    } catch (error) {
      if (error instanceof AuthCodeError && error.code === 'CODE_RATE_LIMITED') {
        throw new HttpException('CODE_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
      }
      throw error;
    }
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    try {
      const session = await this.deviceSessions.refresh(refreshToken);
      const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
      if (!user?.emailVerifiedAt) throw new UnauthorizedException('Invalid refresh token');
      return this.buildAuthResponse(user, {
        accessToken: this.issueAccessToken(user.id, user.email, session.sessionId),
        refreshToken: session.refreshToken,
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string, sessionId: string) {
    await this.deviceSessions.revoke(userId, sessionId);
  }

  async listDevices(userId: string, currentSessionId: string) {
    return (await this.deviceSessions.list(userId)).map((device) => ({
      ...device,
      current: device.id === currentSessionId,
    }));
  }

  async revokeDevice(userId: string, sessionId: string) {
    await this.deviceSessions.revoke(userId, sessionId);
    return { revoked: true as const };
  }

  private issueAccessToken(userId: string, email: string, sessionId: string): string {
    const accessExpiresSec = Number(process.env.JWT_ACCESS_EXPIRES_SEC ?? 900);
    return this.jwtService.sign(
      { sub: userId, email, sid: sessionId },
      {
        secret: accessSecretOrThrow(),
        expiresIn: accessExpiresSec,
      },
    );
  }

  private async openDeviceSession(userId: string, deviceId: string, deviceName?: string) {
    try {
      return await this.deviceSessions.open(userId, deviceId, deviceName ?? 'Устройство SkillCue');
    } catch (error) {
      if (error instanceof DeviceLimitError) {
        throw new ConflictException({ code: 'DEVICE_LIMIT_REACHED', devices: error.devices });
      }
      throw error;
    }
  }

  private async buildAuthResponse(
    user: {
      id: string;
      email: string;
      displayName?: string | null;
      avatarUrl?: string | null;
    },
    tokens: { accessToken: string; refreshToken: string },
  ): Promise<AuthResponse> {
    const subscription = await this.subscriptionsService.getSubscriptionInfo(user.id);
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? null,
        avatarUrl: user.avatarUrl ?? null,
      },
      tokens,
      subscription,
    };
  }
}
