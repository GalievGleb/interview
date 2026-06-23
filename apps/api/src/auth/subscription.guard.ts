import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubStatus } from '@prisma/client';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { SKIP_SUBSCRIPTION_KEY } from './skip-subscription.decorator';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_SUBSCRIPTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return true;
    }

    if (this.subscriptionsService.isDevMode()) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) {
      return false;
    }

    const subscription = await this.subscriptionsService.getByUserId(user.id);
    if (!subscription || subscription.status !== SubStatus.ACTIVE) {
      throw new ForbiddenException('Active subscription required');
    }

    request.subscription = subscription;
    return true;
  }
}
