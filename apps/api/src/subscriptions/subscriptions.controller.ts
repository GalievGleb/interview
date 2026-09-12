import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SubscriptionsService } from './subscriptions.service';
import { SkipSubscription } from '../auth/skip-subscription.decorator';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

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
