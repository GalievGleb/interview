import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SkipSubscription } from '../auth/skip-subscription.decorator';

@Controller('users')
export class UsersController {
  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @SkipSubscription()
  getProfile(@Request() req: { user: { id: string; email: string; hwid: string | null } }) {
    return {
      id: req.user.id,
      email: req.user.email,
      hwid: req.user.hwid,
    };
  }
}
