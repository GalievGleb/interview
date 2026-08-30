import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveChatUpstreamRoute,
  sanitizeOpenAiUpstreamBody,
} from './gateway.service';

test('OpenAI-compatible upstream never receives OpenRouter provider routing', () => {
  const input = {
    model: 'gpt-4o-mini',
    stream: true,
    provider: { sort: 'throughput' },
    messages: [{ role: 'user', content: 'hello' }],
  };

  const output = sanitizeOpenAiUpstreamBody(input);

  assert.equal('provider' in output, false);
  assert.equal(output.model, 'gpt-4o-mini');
  assert.deepEqual(output.messages, input.messages);
  assert.deepEqual(input.provider, { sort: 'throughput' });
});

test('fast live OpenAI models bypass OpenRouter only when a direct key is available', () => {
  const route = resolveChatUpstreamRoute(
    {
      model: 'openai/gpt-4.1-mini',
      stream: true,
      provider: { sort: 'throughput' },
    },
    {
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_STT_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'direct-key',
    },
  );

  assert.deepEqual(route, {
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'direct-key',
    style: 'openai',
    model: 'gpt-4.1-mini',
    directLive: true,
  });
});

test('ordinary and unsupported fast models retain the configured OpenRouter route', () => {
  const environment = {
    GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
    OPENROUTER_API_KEY: 'router-key',
    OPENAI_API_KEY: 'direct-key',
  };

  assert.equal(
    resolveChatUpstreamRoute(
      { model: 'openai/gpt-4.1-mini', stream: true },
      environment,
    ).directLive,
    false,
  );
  assert.equal(
    resolveChatUpstreamRoute(
      {
        model: 'openai/gpt-5.6-sol',
        stream: true,
        provider: { sort: 'throughput' },
      },
      environment,
    ).directLive,
    false,
  );
});
