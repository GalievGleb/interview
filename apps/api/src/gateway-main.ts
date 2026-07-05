/**
 * Отдельная точка входа: ТОЛЬКО гейтвей (лицензии + LLM-прокси + Redis).
 *
 * Полный AppModule тянет Prisma/Postgres и JWT-модули старой архитектуры — для
 * продажи ключей они не нужны. Этот бинарь деплоится на VPS одним systemd-юнитом
 * рядом с redis-server. Запуск: `node dist/gateway-main.js` (GATEWAY_PORT, дефолт 8787).
 */
import { NestFactory } from '@nestjs/core';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), GatewayModule],
})
class GatewayStandaloneModule {}

async function bootstrap() {
  const app = await NestFactory.create(GatewayStandaloneModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: '*' }); // ключ — в Authorization, cookies не используются
  const port = Number(process.env.GATEWAY_PORT ?? 8787);
  await app.listen(port, '0.0.0.0');
  console.log(`SkillCue gateway listening on :${port}`);
}

void bootstrap();
