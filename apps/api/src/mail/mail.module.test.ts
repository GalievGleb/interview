import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { MailModule } from './mail.module';
import { ResendMailClient } from './resend-mail.client';

test('mail module creates the environment-configured Resend client at runtime', async () => {
  const providers = Reflect.getMetadata('providers', MailModule) as unknown[];
  const resendProvider = providers.find(
    (provider) => typeof provider === 'object'
      && provider !== null
      && 'provide' in provider
      && provider.provide === ResendMailClient,
  ) as { useFactory?: unknown } | undefined;
  assert.equal(typeof resendProvider?.useFactory, 'function');

  const context = await NestFactory.createApplicationContext(MailModule, {
    logger: false,
  });
  try {
    assert.ok(context.get(ResendMailClient));
  } finally {
    await context.close();
  }
});
