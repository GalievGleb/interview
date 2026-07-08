/**
 * Отдельная точка входа: ТОЛЬКО гейтвей (лицензии + LLM-прокси + STT-прокси + Redis).
 *
 * Полный AppModule тянет Prisma/Postgres и JWT-модули старой архитектуры — для
 * продажи ключей они не нужны. Этот бинарь деплоится на VPS одним systemd-юнитом
 * рядом с redis-server. Запуск: `node dist/gateway-main.js` (GATEWAY_PORT, дефолт 8787).
 */
import { NestFactory } from '@nestjs/core';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), GatewayModule],
})
class GatewayStandaloneModule {}

async function bootstrap() {
  const app = await NestFactory.create(GatewayStandaloneModule);
  // Без этого @WebSocketGateway поднимается на socket.io по умолчанию, а
  // /gateway/stt/stream (gateway-stt.gateway.ts) — простой WS-релей, с которым
  // desktop-бэкенд говорит через голый `websockets` (Python). Тот же адаптер,
  // что и в main.ts (полный AppModule) для существующего SttGateway/Deepgram.
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: '*' }); // ключ — в Authorization, cookies не используются
  const port = Number(process.env.GATEWAY_PORT ?? 8787);
  // Слушаем ТОЛЬКО localhost: наружу гейтвей смотрит через nginx (домен + TLS),
  // прямой публичный порт 8787 не нужен и был бы лишней поверхностью атаки.
  // Переопределяется GATEWAY_HOST (напр. 0.0.0.0 для теста без nginx).
  const host = process.env.GATEWAY_HOST ?? '127.0.0.1';
  await app.listen(port, host);
  console.log(`SkillCue gateway listening on ${host}:${port}`);
}

void bootstrap();
