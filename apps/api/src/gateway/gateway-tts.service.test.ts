import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GatewayTtsService,
  TTS_MODEL,
  TTS_VOICE,
  buildTtsUpstreamBody,
  normalizeTtsInput,
} from './gateway-tts.service';

test('managed TTS fixes model, voice, WAV, and natural Russian instructions', () => {
  assert.deepEqual(buildTtsUpstreamBody('Что такое тестирование?', 'ru'), {
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    input: 'Что такое тестирование?',
    response_format: 'wav',
    instructions:
      'Говори естественно, спокойно и доброжелательно, как живой интервьюер. Без дикторской манеры.',
  });
  assert.equal(TTS_MODEL, 'gpt-4o-mini-tts');
  assert.equal(TTS_VOICE, 'marin');
});

test('managed TTS normalizes whitespace and rejects empty or oversized input', () => {
  assert.equal(normalizeTtsInput('  Что   такое API?\n'), 'Что такое API?');
  assert.throws(() => normalizeTtsInput('   '), /1-800/);
  assert.throws(() => normalizeTtsInput('x'.repeat(801)), /1-800/);
});

test('managed TTS rejects a license over its speech rate limit', async () => {
  const service = new GatewayTtsService({
    checkRateLimit: async () => false,
  } as never);

  await assert.rejects(
    () =>
      service.synthesize(
        { id: 'license-1', payload: { email: 'test@local' }, budget: 10_000 },
        'Что такое API?',
        'ru',
      ),
    (error: { getStatus?: () => number }) => error.getStatus?.() === 429,
  );
});

test('managed TTS returns upstream WAV bytes without exposing provider JSON', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_TTS_BASE_URL;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_TTS_BASE_URL = 'https://tts.test/v1/';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(Buffer.from('RIFF-test-wav'), {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    });
  }) as typeof fetch;

  try {
    const service = new GatewayTtsService({
      checkRateLimit: async () => true,
    } as never);
    const audio = await service.synthesize(
      { id: 'license-1', payload: { email: 'test@local' }, budget: 10_000 },
      ' Что  такое API? ',
      'ru',
    );

    assert.equal(audio.toString(), 'RIFF-test-wav');
    assert.equal(requests[0]?.url, 'https://tts.test/v1/audio/speech');
    assert.equal(requests[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      input: 'Что такое API?',
      response_format: 'wav',
      instructions:
        'Говори естественно, спокойно и доброжелательно, как живой интервьюер. Без дикторской манеры.',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalBaseUrl === undefined) delete process.env.OPENAI_TTS_BASE_URL;
    else process.env.OPENAI_TTS_BASE_URL = originalBaseUrl;
  }
});
