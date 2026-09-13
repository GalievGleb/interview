import { Body, Controller, Delete, Get, Param, Post, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import {
  EmailCodeDto,
  GoogleLoginDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RequestEmailCodeDto,
  ResetPasswordDto,
} from './dto/auth.dto';
import { SkipSubscription } from './skip-subscription.decorator';

@Controller('auth')
@SkipSubscription()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('verify-email')
  verifyEmail(@Body() dto: EmailCodeDto) {
    return this.authService.verifyEmail(dto);
  }

  @Post('verification/request')
  requestVerification(@Body() dto: RequestEmailCodeDto) {
    return this.authService.requestVerification(dto.email);
  }

  @Post('password-reset/request')
  requestPasswordReset(@Body() dto: RequestEmailCodeDto) {
    return this.authService.requestPasswordReset(dto.email);
  }

  @Post('password-reset/confirm')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('google')
  google(@Body() dto: GoogleLoginDto) {
    return this.authService.loginWithGoogle(dto);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @UseGuards(AuthGuard('jwt'))
  logout(@Request() req: { user: { id: string; sessionId: string } }) {
    return this.authService.logout(req.user.id, req.user.sessionId);
  }

  @Get('devices')
  @UseGuards(AuthGuard('jwt'))
  devices(@Request() req: { user: { id: string; sessionId: string } }) {
    return this.authService.listDevices(req.user.id, req.user.sessionId);
  }

  @Delete('devices/:sessionId')
  @UseGuards(AuthGuard('jwt'))
  revokeDevice(
    @Request() req: { user: { id: string } },
    @Param('sessionId') sessionId: string,
  ) {
    return this.authService.revokeDevice(req.user.id, sessionId);
  }
}
