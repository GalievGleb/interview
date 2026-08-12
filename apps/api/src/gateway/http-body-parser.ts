import type { INestApplication } from '@nestjs/common';
import express from 'express';

/**
 * Vision requests contain a base64 JPEG. Express' default JSON limit is only
 * 100 KiB, which rejects an ordinary screenshot before it reaches the model.
 */
export const GATEWAY_JSON_BODY_LIMIT = '2mb';
export const GATEWAY_STT_BODY_LIMIT = '15mb';

type JsonParserOptions = NonNullable<Parameters<typeof express.json>[0]>;
type RawBodyRequest = express.Request & { rawBody?: Buffer };

const preserveRawBody: NonNullable<JsonParserOptions['verify']> = (request, _response, body) => {
  (request as RawBodyRequest).rawBody = Buffer.from(body);
};

export function configureHttpBodyParsing(app: Pick<INestApplication, 'use'>): void {
  // The live STT endpoint sends a raw WAV rather than JSON. Register it first
  // so the generic parsers never touch the audio stream.
  app.use(
    '/gateway/stt/transcribe',
    express.raw({
      type: ['audio/wav', 'application/octet-stream'],
      limit: GATEWAY_STT_BODY_LIMIT,
    }),
  );
  app.use(express.json({ limit: GATEWAY_JSON_BODY_LIMIT, verify: preserveRawBody }));
  app.use(
    express.urlencoded({
      extended: true,
      limit: GATEWAY_JSON_BODY_LIMIT,
      verify: preserveRawBody,
    }),
  );
}
