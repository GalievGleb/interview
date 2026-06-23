import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { AuthResponse } from '@interview/shared';

const HWID_CHANGE_COOLDOWN_DAYS = 30;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        hwid: dto.hwid ?? null,
      },
    });

    const tokens = await this.issueTokens(user.id, user.email);
    await this.saveRefreshToken(user.id, tokens.refreshToken);

    return this.buildAuthResponse(user, tokens);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (dto.hwid) {
      await this.bindHwid(user.id, user.hwid, user.hwidChangedAt, dto.hwid);
    }

    const tokens = await this.issueTokens(user.id, user.email);
    await this.saveRefreshToken(user.id, tokens.refreshToken);

    const updatedUser = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return this.buildAuthResponse(updatedUser, tokens);
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    let payload: { sub: string; email: string };
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me',
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.refreshToken !== refreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokens = await this.issueTokens(user.id, user.email);
    await this.saveRefreshToken(user.id, tokens.refreshToken);
    return this.buildAuthResponse(user, tokens);
  }

  async logout(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: null },
    });
  }

  private async bindHwid(
    userId: string,
    currentHwid: string | null,
    hwidChangedAt: Date | null,
    newHwid: string,
  ) {
    if (!currentHwid) {
      await this.prisma.user.update({ where: { id: userId }, data: { hwid: newHwid } });
      return;
    }

    if (currentHwid === newHwid) {
      return;
    }

    const cooldownMs = HWID_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    if (hwidChangedAt && Date.now() - hwidChangedAt.getTime() < cooldownMs) {
      throw new ForbiddenException('Device change allowed once every 30 days');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { hwid: newHwid, hwidChangedAt: new Date() },
    });
  }

  private async issueTokens(userId: string, email: string) {
    const accessExpiresSec = Number(process.env.JWT_ACCESS_EXPIRES_SEC ?? 900);
    const refreshExpiresSec = Number(process.env.JWT_REFRESH_EXPIRES_SEC ?? 604800);

    const accessToken = this.jwtService.sign(
      { sub: userId, email },
      {
        secret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
        expiresIn: accessExpiresSec,
      },
    );
    const refreshToken = this.jwtService.sign(
      { sub: userId, email },
      {
        secret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me',
        expiresIn: refreshExpiresSec,
      },
    );
    return { accessToken, refreshToken };
  }

  private async saveRefreshToken(userId: string, refreshToken: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken },
    });
  }

  private async buildAuthResponse(
    user: { id: string; email: string; hwid: string | null },
    tokens: { accessToken: string; refreshToken: string },
  ): Promise<AuthResponse> {
    const subscription = await this.subscriptionsService.getSubscriptionInfo(user.id);
    return {
      user: { id: user.id, email: user.email, hwid: user.hwid },
      tokens,
      subscription,
    };
  }
}
