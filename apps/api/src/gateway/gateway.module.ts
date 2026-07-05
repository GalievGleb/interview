import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';

@Module({
  imports: [RedisModule],
  controllers: [GatewayController],
  providers: [GatewayService],
})
export class GatewayModule {}
