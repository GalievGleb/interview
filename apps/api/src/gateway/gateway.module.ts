import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { BillingService } from './billing.service';
import { GatewaySttService } from './gateway-stt.service';
import { GatewaySttQuotaService } from './gateway-stt-quota.util';
import { GatewaySttUploadGuard } from './gateway-stt-upload.guard';
import { GatewayTtsService } from './gateway-tts.service';
import { GatewaySttRealtimeGateway } from './gateway-stt-realtime.gateway';

@Module({
  imports: [RedisModule],
  controllers: [GatewayController],
  providers: [
    GatewayService,
    BillingService,
    GatewaySttService,
    GatewaySttQuotaService,
    GatewaySttUploadGuard,
    GatewaySttRealtimeGateway,
    GatewayTtsService,
  ],
})
export class GatewayModule {}
