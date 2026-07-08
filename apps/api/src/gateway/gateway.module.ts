import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { GatewaySttGateway } from './gateway-stt.gateway';
import { GatewaySttService } from './gateway-stt.service';
import { GatewaySttQuotaService } from './gateway-stt-quota.util';

@Module({
  imports: [RedisModule],
  controllers: [GatewayController],
  providers: [GatewayService, GatewaySttGateway, GatewaySttService, GatewaySttQuotaService],
})
export class GatewayModule {}
