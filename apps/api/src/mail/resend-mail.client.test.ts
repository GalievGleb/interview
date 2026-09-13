import assert from 'node:assert/strict';
import test from 'node:test';
import { ResendMailClient, type MailFetch } from './resend-mail.client';

test('sends a verification code with the configured SkillCue sender', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: MailFetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: 'email-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new ResendMailClient(
    {
      apiKey: 're_private-test-key',
      from: 'SkillCue <no-reply@skill-cue.ru>',
    },
    fetcher,
  );

  await client.sendVerificationCode('person@example.com', '431209', 'verify_email');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, {
    Authorization: 'Bearer re_private-test-key',
    'Content-Type': 'application/json',
  });
  const payload = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.equal(payload.from, 'SkillCue <no-reply@skill-cue.ru>');
  assert.deepEqual(payload.to, ['person@example.com']);
  assert.equal(payload.subject, 'Код подтверждения SkillCue');
  assert.match(String(payload.text), /431209/);
  assert.match(String(payload.html), /431209/);
});

test('refuses to send when the server API key is missing', async () => {
  const client = new ResendMailClient(
    { apiKey: '', from: 'SkillCue <no-reply@skill-cue.ru>' },
    async () => new Response('{}', { status: 200 }),
  );

  await assert.rejects(
    () => client.sendVerificationCode('person@example.com', '431209', 'verify_email'),
    /Transactional email is not configured/,
  );
});

test('provider failures are redacted and never expose the API key', async () => {
  const secret = 're_must-never-leak';
  const client = new ResendMailClient(
    { apiKey: secret, from: 'SkillCue <no-reply@skill-cue.ru>' },
    async () => new Response(`provider rejected ${secret}`, { status: 403 }),
  );

  let message = '';
  try {
    await client.sendVerificationCode('person@example.com', '431209', 'reset_password');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.equal(message, 'Transactional email provider rejected the request');
  assert.equal(message.includes(secret), false);
});
