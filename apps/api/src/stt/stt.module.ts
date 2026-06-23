import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SttGateway } from './stt.gateway';
import { SttService } from './stt.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [SubscriptionsModule, JwtModule.register({})],
  providers: [SttGateway, SttService],
})
export class SttModule {}
