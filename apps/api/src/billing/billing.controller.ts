import {
  Body,
  Controller,
  Headers,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request as ExpressRequest } from 'express';
import { BillingService } from './billing.service';
import { CheckoutDto } from './dto/checkout.dto';
import { SkipSubscription } from '../auth/skip-subscription.decorator';

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('checkout')
  @UseGuards(AuthGuard('jwt'))
  @SkipSubscription()
  checkout(
    @Request() req: { user: { id: string; email: string } },
    @Body() dto: CheckoutDto,
  ) {
    return this.billingService.createCheckout(req.user.id, req.user.email, dto);
  }

  @Post('webhooks/stripe')
  @SkipSubscription()
  stripeWebhook(
    @Req() req: RawBodyRequest<ExpressRequest>,
    @Headers('stripe-signature') signature: string,
  ) {
    const payload = req.rawBody;
    if (!payload || !signature) {
      throw new Error('Missing Stripe webhook payload or signature');
    }
    return this.billingService.handleStripeWebhook(payload, signature);
  }

  @Post('webhooks/yookassa')
  @SkipSubscription()
  yookassaWebhook(@Body() body: Record<string, unknown>) {
    return this.billingService.handleYookassaWebhook(body);
  }
}
