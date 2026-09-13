import { Body, Controller, Get, Post, UseGuards, Request } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { AuthGuard } from '@nestjs/passport';
import { SubscriptionsService } from './subscriptions.service';
import { SkipSubscription } from '../auth/skip-subscription.decorator';

class IssuedLicenseDto {
  @IsString()
  @MaxLength(4096)
  key!: string;
}

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  // Ed25519 issuer signature is the authorization here. Recipient and expiry
  // come ONLY from that signature, never from caller-supplied account fields.
  @Post('issued-license')
  @SkipSubscription()
  registerIssuedLicense(@Body() body: IssuedLicenseDto) {
    return this.subscriptionsService.registerIssuedLicense(body.key);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  @SkipSubscription()
  getMySubscription(@Request() req: { user: { id: string } }) {
    return this.subscriptionsService.getSubscriptionInfo(req.user.id);
  }

  @Get('license')
  @UseGuards(AuthGuard('jwt'))
  @SkipSubscription()
  getManagedLicense(@Request() req: { user: { id: string } }) {
    return this.subscriptionsService.getManagedLicense(req.user.id);
  }
}
