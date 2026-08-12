import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import {
  configureHttpBodyParsing,
  GATEWAY_JSON_BODY_LIMIT,
} from './http-body-parser';

test('gateway accepts a screenshot JSON body larger than Express default 100 KiB', async () => {
  const application = express();
  configureHttpBodyParsing(application as never);
  application.post('/v1/chat/completions', (request, response) => {
    const rawBody = (request as express.Request & { rawBody?: Buffer }).rawBody;
    response.json({ imageLength: String(request.body.image ?? '').length, rawBytes: rawBody?.length });
  });

  const server = application.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'A'.repeat(300_000) }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { imageLength: 300_000, rawBytes: 300_012 });
    assert.equal(GATEWAY_JSON_BODY_LIMIT, '2mb');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
