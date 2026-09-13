import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GatewayService,
  proxyUrlForChatRoute,
  resolveChatUpstreamRoute,
  sanitizeOpenAiUpstreamBody,
} from './gateway.service';

const VALID_IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

function screenBody(model = 'openai/gpt-5.6-sol') {
  return {
    model,
    stream: true,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Solve the visible task.' },
          { type: 'image_url', image_url: { url: VALID_IMAGE } },
        ],
      },
    ],
  };
}

function fakeRedis() {
  return {
    checkRateLimit: async () => true,
    getClient: () => ({ get: async () => null }),
  } as never;
}

function maxLicense() {
  return {
    id: 'max-license',
    payload: { email: 'max@example.test', plan: 'max' },
    budget: 20_000_000,
  };
}

async function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
) {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    before.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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
      { model: 'anthropic/claude-sonnet-4.5', stream: true },
      environment,
    ).directLive,
    false,
  );
});

test('quality-first screen GPT-5.6 uses the configured direct OpenAI route', () => {
  const route = resolveChatUpstreamRoute(
    screenBody(),
    {
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_CHAT_API_KEY: 'direct-chat-key',
      OPENAI_STT_BASE_URL: 'https://stt.example/v1',
      OPENAI_API_KEY: 'legacy-key',
    },
    { screenAuthorized: true },
  );

  assert.deepEqual(route, {
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'direct-chat-key',
    style: 'openai',
    model: 'gpt-5.6-sol',
    directLive: true,
  });
});

test('dedicated chat key defaults to official OpenAI instead of inheriting a custom STT base', () => {
  const route = resolveChatUpstreamRoute(
    screenBody(),
    {
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: 'direct-chat-key',
      OPENAI_STT_BASE_URL: 'https://stt.example/v1',
      OPENAI_API_KEY: 'legacy-stt-key',
    },
    { screenAuthorized: true },
  );

  assert.equal(route.directLive, true);
  assert.equal(route.baseURL, 'https://api.openai.com/v1');
  assert.equal(route.apiKey, 'direct-chat-key');
});

test('partial dedicated chat configuration never pairs its base with the legacy STT key', () => {
  const route = resolveChatUpstreamRoute(
    screenBody(),
    {
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'legacy-stt-key',
      OPENAI_STT_BASE_URL: 'https://api.openai.com/v1',
    },
    { screenAuthorized: true },
  );

  assert.equal(route.directLive, false);
  assert.equal(route.baseURL, 'https://openrouter.ai/api/v1');
});

test('quality-first screen GPT-5.6 never bypasses through an untrusted custom direct base', () => {
  const route = resolveChatUpstreamRoute(
    screenBody(),
    {
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_STT_BASE_URL: 'https://proxy.example/v1',
      OPENAI_API_KEY: 'direct-key',
    },
    { screenAuthorized: true },
  );

  assert.equal(route.directLive, false);
  assert.equal(route.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(route.model, 'openai/gpt-5.6-sol');
});

test('quality-first screen route accepts the legacy OpenAI key and STT base', () => {
  const route = resolveChatUpstreamRoute(
    screenBody(),
    {
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_STT_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'legacy-key',
    },
    { screenAuthorized: true },
  );

  assert.equal(route.directLive, true);
  assert.equal(route.apiKey, 'legacy-key');
  assert.equal(route.baseURL, 'https://api.openai.com/v1');
});

test('historical, malformed, and empty images never activate direct screen routing', () => {
  const environment = {
    GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
    OPENROUTER_API_KEY: 'router-key',
    OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_CHAT_API_KEY: 'direct-key',
  };
  const cases = [
    {
      ...screenBody(),
      messages: [
        screenBody().messages[0],
        { role: 'assistant', content: 'Earlier answer.' },
        { role: 'user', content: 'Now answer without looking at the screen.' },
      ],
    },
    {
      ...screenBody(),
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }],
    },
    {
      ...screenBody(),
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' } }] },
      ],
    },
    {
      ...screenBody(),
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] },
      ],
    },
    {
      ...screenBody(),
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,a' } }] },
      ],
    },
    {
      ...screenBody(),
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } }] },
      ],
    },
    {
      ...screenBody(),
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] },
      ],
    },
  ];

  for (const body of cases) {
    assert.equal(resolveChatUpstreamRoute(body, environment).directLive, false);
  }
});

test('direct OpenAI uses only its explicit proxy or HTTPS_PROXY', () => {
  const route = resolveChatUpstreamRoute(
    screenBody(),
    {
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: 'direct-key',
    },
    { screenAuthorized: true },
  );

  assert.equal(
    proxyUrlForChatRoute(route, {
      OPENROUTER_PROXY: 'http://router-proxy.test:8080',
      HTTPS_PROXY: 'http://https-proxy.test:8080',
    }),
    'http://https-proxy.test:8080',
  );
  assert.equal(
    proxyUrlForChatRoute(route, {
      OPENAI_CHAT_PROXY: 'http://chat-proxy.test:8080',
      OPENROUTER_PROXY: 'http://router-proxy.test:8080',
      HTTPS_PROXY: 'http://https-proxy.test:8080',
    }),
    'http://chat-proxy.test:8080',
  );
  assert.equal(
    proxyUrlForChatRoute(
      { ...route, style: 'openrouter', directLive: false },
      {
        OPENROUTER_PROXY: 'http://router-proxy.test:8080',
        HTTPS_PROXY: 'http://https-proxy.test:8080',
      },
    ),
    'http://router-proxy.test:8080',
  );
});

test('max screen request bypasses a restrictive ordinary allowlist, but basic never does', async () => {
  await withEnvironment(
    {
      GATEWAY_ALLOWED_MODELS: 'qwen/qwen3.8-flash',
      GATEWAY_BLOCKED_MODELS: undefined,
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: 'direct-key',
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ input: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (input, init) => {
        calls.push({ input: String(input), init });
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      try {
        const service = new GatewayService(fakeRedis());
        const maxResponse = await service.chatCompletions(maxLicense(), screenBody());
        assert.equal(maxResponse.status, 200);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.input, 'https://api.openai.com/v1/chat/completions');
        const directBody = JSON.parse(String(calls[0]?.init?.body));
        assert.equal('temperature' in directBody, false);

        const basic = {
          id: 'basic-license',
          payload: { email: 'basic@example.test', plan: 'basic' },
          budget: 5_000_000,
        };
        await assert.rejects(
          service.chatCompletions(basic, screenBody()),
          (error: unknown) => {
            assert.equal((error as { status?: number }).status, 403);
            return true;
          },
        );
        assert.equal(calls.length, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('max screen request uses configured OpenRouter when direct OpenAI is unavailable', async () => {
  await withEnvironment(
    {
      GATEWAY_ALLOWED_MODELS: 'qwen/qwen3.8-flash',
      GATEWAY_BLOCKED_MODELS: undefined,
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: undefined,
      OPENAI_CHAT_BASE_URL: undefined,
      OPENAI_API_KEY: undefined,
      OPENAI_STT_BASE_URL: undefined,
    },
    async () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      try {
        const service = new GatewayService(fakeRedis());
        const response = await service.chatCompletions(maxLicense(), screenBody());
        assert.equal(response.status, 200);
        assert.equal(calls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('direct screen request falls back once to OpenRouter only for pre-response transient errors', async () => {
  await withEnvironment(
    {
      GATEWAY_ALLOWED_MODELS: 'qwen/qwen3.8-flash,openai/gpt-5.6-sol',
      GATEWAY_BLOCKED_MODELS: undefined,
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      GATEWAY_UPSTREAM_STYLE: 'openrouter',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: 'direct-key',
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ input: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (input, init) => {
        calls.push({ input: String(input), init });
        if (calls.length === 1) return new Response('busy', { status: 503 });
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      try {
        const service = new GatewayService(fakeRedis());
        const response = await service.chatCompletions(maxLicense(), screenBody());
        assert.equal(response.status, 200);
        assert.deepEqual(
          calls.map((call) => call.input),
          [
            'https://api.openai.com/v1/chat/completions',
            'https://openrouter.ai/api/v1/chat/completions',
          ],
        );
        const fallbackBody = JSON.parse(String(calls[1]?.init?.body));
        assert.equal(fallbackBody.model, 'openai/gpt-5.6-sol');
        assert.equal(
          (calls[1]?.init?.headers as Record<string, string>).Authorization,
          'Bearer router-key',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('direct screen transient response never falls back through a restrictive cost allowlist', async () => {
  await withEnvironment(
    {
      GATEWAY_ALLOWED_MODELS: 'qwen/qwen3.8-flash',
      GATEWAY_BLOCKED_MODELS: undefined,
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      GATEWAY_UPSTREAM_STYLE: 'openrouter',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: 'direct-key',
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = (async (input) => {
        calls.push(String(input));
        return new Response('busy', { status: 503 });
      }) as typeof fetch;
      try {
        const service = new GatewayService(fakeRedis());
        const response = await service.chatCompletions(maxLicense(), screenBody());
        assert.equal(response.status, 503);
        assert.deepEqual(calls, ['https://api.openai.com/v1/chat/completions']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('direct screen transport error never falls back through a restrictive cost allowlist', async () => {
  await withEnvironment(
    {
      GATEWAY_ALLOWED_MODELS: 'qwen/qwen3.8-flash',
      GATEWAY_BLOCKED_MODELS: undefined,
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      GATEWAY_UPSTREAM_STYLE: 'openrouter',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: 'direct-key',
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = (async (input) => {
        calls.push(String(input));
        throw new TypeError('direct transport failed');
      }) as typeof fetch;
      try {
        const service = new GatewayService(fakeRedis());
        await assert.rejects(
          service.chatCompletions(maxLicense(), screenBody()),
          /direct transport failed/,
        );
        assert.deepEqual(calls, ['https://api.openai.com/v1/chat/completions']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('direct screen request never falls back on auth failures', async () => {
  await withEnvironment(
    {
      GATEWAY_ALLOWED_MODELS: 'qwen/qwen3.8-flash',
      GATEWAY_BLOCKED_MODELS: undefined,
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      GATEWAY_UPSTREAM_STYLE: 'openrouter',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: 'direct-key',
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
    },
    async () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response('unauthorized', { status: 401 });
      }) as typeof fetch;
      try {
        const service = new GatewayService(fakeRedis());
        const response = await service.chatCompletions(maxLicense(), screenBody());
        assert.equal(response.status, 401);
        assert.equal(calls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('direct screen request falls back once on transport failure and never retries fallback', async () => {
  await withEnvironment(
    {
      GATEWAY_ALLOWED_MODELS: 'qwen/qwen3.8-flash,openai/gpt-5.6-sol',
      GATEWAY_BLOCKED_MODELS: undefined,
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      GATEWAY_UPSTREAM_STYLE: 'openrouter',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: 'direct-key',
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
    },
    async () => {
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = (async (input) => {
        calls.push(String(input));
        throw new TypeError(calls.length === 1 ? 'direct transport failed' : 'fallback failed');
      }) as typeof fetch;
      try {
        const service = new GatewayService(fakeRedis());
        await assert.rejects(
          service.chatCompletions(maxLicense(), screenBody()),
          /fallback failed/,
        );
        assert.deepEqual(calls, [
          'https://api.openai.com/v1/chat/completions',
          'https://openrouter.ai/api/v1/chat/completions',
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('aborted direct screen request never falls back', async () => {
  await withEnvironment(
    {
      GATEWAY_ALLOWED_MODELS: 'qwen/qwen3.8-flash',
      GATEWAY_BLOCKED_MODELS: undefined,
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      GATEWAY_UPSTREAM_STYLE: 'openrouter',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_CHAT_API_KEY: 'direct-key',
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
    },
    async () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        throw new DOMException('The operation was aborted', 'AbortError');
      }) as typeof fetch;
      try {
        const controller = new AbortController();
        controller.abort();
        const service = new GatewayService(fakeRedis());
        await assert.rejects(
          service.chatCompletions(maxLicense(), screenBody(), controller.signal),
          (error: unknown) => (error as { name?: unknown }).name === 'AbortError',
        );
        assert.equal(calls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});

test('text-only GPT-5.6 keeps the configured gateway route', () => {
  const route = resolveChatUpstreamRoute(
    {
      model: 'openai/gpt-5.6-sol',
      stream: true,
      messages: [{ role: 'user', content: 'Answer this text question.' }],
    },
    {
      GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'router-key',
      OPENAI_STT_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'direct-key',
    },
  );

  assert.equal(route.directLive, false);
  assert.equal(route.baseURL, 'https://openrouter.ai/api/v1');
});

test('known OpenRouter host overrides a stale OpenAI style without remapping model ids', () => {
  const environment = {
    GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
    GATEWAY_UPSTREAM_STYLE: 'openai',
    OPENROUTER_API_KEY: 'router-key',
  };

  for (const model of ['qwen/qwen3.8-flash', 'openai/gpt-5.6-sol']) {
    const route = resolveChatUpstreamRoute({ model, stream: true }, environment);

    assert.equal(route.style, 'openrouter');
    assert.equal(route.model, model);
  }
});

test('explicit OpenRouter style remains authoritative for a custom proxy', () => {
  const route = resolveChatUpstreamRoute(
    { model: 'qwen/qwen3.8-flash', stream: true },
    {
      GATEWAY_UPSTREAM_BASE: 'https://llm-proxy.example/v1',
      GATEWAY_UPSTREAM_STYLE: 'openrouter',
      OPENROUTER_API_KEY: 'proxy-key',
    },
  );

  assert.equal(route.style, 'openrouter');
  assert.equal(route.model, 'qwen/qwen3.8-flash');
});

test('known OpenAI host overrides a stale OpenRouter style', () => {
  const route = resolveChatUpstreamRoute(
    { model: 'openai/gpt-4o-mini', stream: true },
    {
      GATEWAY_UPSTREAM_BASE: 'https://api.openai.com/v1',
      GATEWAY_UPSTREAM_STYLE: 'openrouter',
      OPENROUTER_API_KEY: 'openai-compatible-key',
    },
  );

  assert.equal(route.style, 'openai');
  assert.equal(route.model, 'gpt-4o-mini');
});
