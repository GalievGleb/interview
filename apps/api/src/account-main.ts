import { Controller, Get, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { configureHttpBodyParsing } from './gateway/http-body-parser';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { UsersModule } from './users/users.module';

@Controller('health')
class AccountHealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, service: 'skillcue-account' };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    SubscriptionsModule,
    BillingModule,
  ],
  controllers: [AccountHealthController],
})
class AccountStandaloneModule {}

async function bootstrap() {
  const app = await NestFactory.create(AccountStandaloneModule, { bodyParser: false });
  configureHttpBodyParsing(app);
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));
  app.enableCors({
    origin: ['https://skill-cue.ru', 'https://www.skill-cue.ru'],
    methods: ['GET', 'POST', 'DELETE'],
  });
  const port = Number(process.env.ACCOUNT_API_PORT ?? 8788);
  const host = process.env.ACCOUNT_API_HOST ?? '127.0.0.1';
  await app.listen(port, host);
  console.log(`SkillCue account API listening on ${host}:${port}`);
}

void bootstrap();
