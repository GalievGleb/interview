import { Module } from '@nestjs/common';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SubscriptionsModule, AuthModule],
  controllers: [LlmController],
  providers: [LlmService],
})
export class LlmModule {}
