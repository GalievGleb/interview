import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { SubscriptionGuard } from './subscription.guard';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    SubscriptionsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, SubscriptionGuard],
  exports: [AuthService, SubscriptionGuard, JwtModule, PassportModule],
})
export class AuthModule {}
