import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { BillingService } from './billing.service';
import { GatewaySttService } from './gateway-stt.service';
import { GatewaySttQuotaService } from './gateway-stt-quota.util';

@Module({
  imports: [RedisModule],
  controllers: [GatewayController],
  providers: [
    GatewayService,
    BillingService,
    GatewaySttService,
    GatewaySttQuotaService,
  ],
})
export class GatewayModule {}
