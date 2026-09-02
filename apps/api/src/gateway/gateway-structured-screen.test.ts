import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayController } from './gateway.controller';
import { GatewayService, resolveChatUpstreamRoute } from './gateway.service';

const VALID_IMAGE = 'data:image/png;base64,iVBORw0KGgo=';
const STRUCTURED_WORKLOAD = 'structured-screen-v1';

type StructuredPhase = 'observation' | 'answer' | 'repair';

function fakeRedis() {
  return {
    checkRateLimit: async () => true,
    getClient: () => ({ get: async () => null }),
  } as never;
}

function license(plan: string | undefined) {
  return {
    id: `${plan ?? 'missing'}-license`,
    payload: { email: `${plan}@example.test`, plan },
    budget: 20_000_000,
  };
}

function observationBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'openai/gpt-5.6-sol',
    max_tokens: 1_800,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract the visible task.' },
          { type: 'image_url', image_url: { url: VALID_IMAGE } },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'screen_task_observation',
        strict: true,
        schema: { type: 'object' },
      },
    },
    ...overrides,
  };
}

function answerBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'openai/gpt-5.6-sol',
    max_tokens: 4_200,
    messages: [{ role: 'user', content: 'Answer from the trusted task ledger.' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'screen_analysis',
        strict: true,
        schema: { type: 'object' },
      },
    },
    ...overrides,
  };
}

function structuredHeaders(phase: StructuredPhase): Record<string, unknown> {
  return { workload: STRUCTURED_WORKLOAD, phase };
}

function callStructured(
  service: GatewayService,
  plan: string | undefined,
  body: Record<string, unknown>,
  headers: Record<string, unknown>,
): Promise<Response> {
  const call = service.chatCompletions as unknown as (
    verifiedLicense: ReturnType<typeof license>,
    requestBody: Record<string, unknown>,
    signal: AbortSignal | undefined,
    requestHeaders: Record<string, unknown>,
  ) => Promise<Response>;
  return call.call(service, license(plan), body, undefined, headers);
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

const DIRECT_ENVIRONMENT = {
  GATEWAY_ALLOWED_MODELS: 'openai/gpt-5.6-sol,openai/gpt-5.6',
  GATEWAY_BLOCKED_MODELS: undefined,
  GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
  GATEWAY_UPSTREAM_STYLE: 'openrouter',
  OPENROUTER_API_KEY: 'router-key',
  OPENAI_CHAT_API_KEY: 'direct-key',
  OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_API_KEY: undefined,
  OPENAI_STT_BASE_URL: undefined,
};

async function captureFetches(
  run: (calls: Array<{ input: string; init?: RequestInit }>) => Promise<void>,
  respond: (call: number) => Response = () => new Response('{}', { status: 200 }),
) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input: String(input), init });
    return respond(calls.length);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function assertForbiddenBeforeFetch(
  run: () => Promise<unknown>,
  calls: Array<unknown>,
) {
  await assert.rejects(run(), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 403);
    return true;
  });
  assert.equal(calls.length, 0);
}

test('authorized structured observation uses the official direct OpenAI route', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(async (calls) => {
      const service = new GatewayService(fakeRedis());
      const response = await callStructured(
        service,
        'max',
        observationBody(),
        structuredHeaders('observation'),
      );

      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.input, 'https://api.openai.com/v1/chat/completions');
      const upstreamBody = JSON.parse(String(calls[0]?.init?.body));
      assert.equal(upstreamBody.model, 'gpt-5.6-sol');
      assert.equal(upstreamBody.max_completion_tokens, 1_800);
      assert.equal('max_tokens' in upstreamBody, false);
      assert.equal('provider' in upstreamBody, false);
    });
  });
});

test('authorized structured answer and repair accept only the safe schema allowlist', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(async (calls) => {
      const service = new GatewayService(fakeRedis());
      const allowedNames = [
        undefined,
        'screen_analysis',
        'screen_checklist',
        'screen_direct_answer',
        'screen_execution_result',
      ];

      for (const phase of ['answer', 'repair'] as const) {
        for (const name of allowedNames) {
          const body = answerBody(
            name
              ? {
                  response_format: {
                    type: 'json_schema',
                    json_schema: { name, strict: true, schema: { type: 'object' } },
                  },
                }
              : { response_format: undefined },
          );
          const response = await callStructured(
            service,
            'max',
            body,
            structuredHeaders(phase),
          );
          assert.equal(response.status, 200);
        }
      }

      assert.equal(calls.length, 10);
      assert.ok(
        calls.every((call) => call.input === 'https://api.openai.com/v1/chat/completions'),
      );
    });
  });
});

test('unknown or malformed structured-screen headers fail closed before fetch', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(async (calls) => {
      const service = new GatewayService(fakeRedis());
      const malformedHeaders = [
        { workload: 'structured-screen-v2', phase: 'observation' },
        { workload: STRUCTURED_WORKLOAD, phase: 'unknown' },
        { workload: STRUCTURED_WORKLOAD },
        { phase: 'observation' },
        { workload: ` ${STRUCTURED_WORKLOAD}`, phase: 'observation' },
        { workload: STRUCTURED_WORKLOAD, phase: ['observation'] },
      ];

      for (const headers of malformedHeaders) {
        await assertForbiddenBeforeFetch(
          () => callStructured(service, 'max', observationBody(), headers),
          calls,
        );
      }
    });
  });
});

test('trial and basic licenses cannot use GPT-5.6 with or without structured markers', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(async (calls) => {
      const service = new GatewayService(fakeRedis());
      for (const plan of ['trial', 'basic'] as const) {
        await assertForbiddenBeforeFetch(
          () =>
            callStructured(
              service,
              plan,
              observationBody({ plan: 'max', provider: { sort: 'throughput' } }),
              { ...structuredHeaders('observation'), dev: 'true' },
            ),
          calls,
        );
        for (const model of [
          'openai/gpt-5.6-sol',
          'OPENAI/GPT-5.6-SOL',
          ' openai/gpt-5.6-sol ',
        ]) {
          await assertForbiddenBeforeFetch(
            () =>
              callStructured(
                service,
                plan,
                answerBody({
                  model,
                  plan: 'max',
                  provider: { sort: 'throughput' },
                }),
                { dev: 'true' },
              ),
            calls,
          );
        }
      }
    });
  });
});

test('structured authorization requires the verified signed plan to be exactly max', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(async (calls) => {
      const service = new GatewayService(fakeRedis());
      for (const signedPlan of ['pro', 'full', 'MAX', undefined]) {
        await assertForbiddenBeforeFetch(
          () =>
            callStructured(
              service,
              signedPlan,
              observationBody(),
              structuredHeaders('observation'),
            ),
          calls,
        );
      }
    });
  });
});

test('structured observation rejects every unbounded or ambiguous request shape', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(async (calls) => {
      const service = new GatewayService(fakeRedis());
      const historicalImage = observationBody({
        messages: [
          observationBody().messages[0],
          { role: 'user', content: 'The current turn has no image.' },
        ],
      });
      const malformedBodies = [
        observationBody({ stream: true }),
        observationBody({ stream: 'false' }),
        observationBody({ max_tokens: undefined }),
        observationBody({ max_tokens: 1_801 }),
        observationBody({ max_tokens: 1_000.5 }),
        observationBody({ max_tokens: '1800' }),
        observationBody({ messages: [{ role: 'user', content: 'No image.' }] }),
        historicalImage,
        observationBody({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
                },
              ],
            },
          ],
        }),
        observationBody({ response_format: undefined }),
        observationBody({ response_format: { type: 'json_object' } }),
        observationBody({
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'screen_analysis', schema: { type: 'object' } },
          },
        }),
        observationBody({
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'screen_task_observation' },
          },
        }),
        observationBody({ provider: { sort: 'throughput' } }),
        observationBody({ tools: [] }),
        observationBody({ tool_choice: 'none' }),
        observationBody({ n: 2 }),
      ];

      for (const body of malformedBodies) {
        await assertForbiddenBeforeFetch(
          () =>
            callStructured(service, 'max', body, structuredHeaders('observation')),
          calls,
        );
      }
    });
  });
});

test('structured answer and repair reject images, excessive output, tools, and unsafe schemas', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(async (calls) => {
      const service = new GatewayService(fakeRedis());
      const malformedBodies = [
        answerBody({ stream: true }),
        answerBody({ stream: 'false' }),
        answerBody({ max_tokens: undefined }),
        answerBody({ max_tokens: 4_201 }),
        answerBody({ max_tokens: 1_000.5 }),
        answerBody({
          messages: [
            observationBody().messages[0],
            { role: 'user', content: 'Use the earlier image.' },
          ],
        }),
        answerBody({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'invalid' } }],
            },
          ],
        }),
        answerBody({
          messages: [
            {
              role: 'user',
              content: { type: 'image_url', image_url: { url: VALID_IMAGE } },
            },
          ],
        }),
        answerBody({ response_format: null }),
        answerBody({ response_format: { type: 'json_object' } }),
        answerBody({
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'arbitrary_schema', schema: { type: 'object' } },
          },
        }),
        answerBody({
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'screen_analysis' },
          },
        }),
        answerBody({ provider: { sort: 'throughput' } }),
        answerBody({ tools: [] }),
        answerBody({ function_call: 'none' }),
        answerBody({ n: 2 }),
      ];

      for (const phase of ['answer', 'repair'] as const) {
        for (const body of malformedBodies) {
          await assertForbiddenBeforeFetch(
            () => callStructured(service, 'max', body, structuredHeaders(phase)),
            calls,
          );
        }
      }
    });
  });
});

test('structured-screen routing accepts only the exact managed GPT-5.6 model ids', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(async (calls) => {
      const service = new GatewayService(fakeRedis());
      for (const model of ['gpt-5.6-sol', 'gpt-5.6', 'openai/gpt-5.6-sol', 'openai/gpt-5.6']) {
        const response = await callStructured(
          service,
          'max',
          answerBody({ model }),
          structuredHeaders('answer'),
        );
        assert.equal(response.status, 200);
      }

      assert.equal(calls.length, 4);
      for (const model of [
        'gpt-5.6-sol-preview',
        'gpt-5.6-mini',
        'anthropic/gpt-5.6-sol',
        'openai/gpt-5.6-sol:free',
      ]) {
        await assertForbiddenBeforeFetch(
          () =>
            callStructured(
              service,
              'max',
              answerBody({ model }),
              structuredHeaders('answer'),
            ),
          calls.slice(4),
        );
      }
      assert.equal(calls.length, 4);
    });
  });
});

test('structured-screen requests fail closed when the official direct route is unavailable', async () => {
  const unavailableRoutes = [
    {
      OPENAI_CHAT_API_KEY: undefined,
      OPENAI_CHAT_BASE_URL: undefined,
      OPENAI_API_KEY: undefined,
      OPENAI_STT_BASE_URL: undefined,
    },
    {
      OPENAI_CHAT_API_KEY: 'direct-key',
      OPENAI_CHAT_BASE_URL: 'https://proxy.example/v1',
      OPENAI_API_KEY: undefined,
      OPENAI_STT_BASE_URL: undefined,
    },
    {
      OPENAI_CHAT_API_KEY: undefined,
      OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'legacy-key',
      OPENAI_STT_BASE_URL: 'https://api.openai.com/v1',
    },
  ];

  for (const unavailable of unavailableRoutes) {
    await withEnvironment({ ...DIRECT_ENVIRONMENT, ...unavailable }, async () => {
      await captureFetches(async (calls) => {
        const service = new GatewayService(fakeRedis());
        await assertForbiddenBeforeFetch(
          () =>
            callStructured(
              service,
              'max',
              observationBody(),
              structuredHeaders('observation'),
            ),
          calls,
        );
      });
    });
  }
});

test('unmarked max GPT-5.6 text stays on the configured route and cannot self-authorize direct', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(async (calls) => {
      const service = new GatewayService(fakeRedis());
      const response = await callStructured(
        service,
        'max',
        answerBody({
          plan: 'max',
          structured_screen: true,
          provider: { sort: 'throughput' },
        }),
        { dev: 'true' },
      );

      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.input, 'https://openrouter.ai/api/v1/chat/completions');
    });
  });
});

test('direct screen resolver requires authorization computed outside the request body', () => {
  const body = observationBody({
    stream: true,
    plan: 'max',
    dev: true,
    provider: { sort: 'throughput' },
    headers: {
      'x-skillcue-workload': STRUCTURED_WORKLOAD,
      'x-skillcue-screen-phase': 'observation',
    },
  });
  const route = resolveChatUpstreamRoute(body, {
    GATEWAY_UPSTREAM_BASE: 'https://openrouter.ai/api/v1',
    OPENROUTER_API_KEY: 'router-key',
    OPENAI_CHAT_API_KEY: 'direct-key',
    OPENAI_CHAT_BASE_URL: 'https://api.openai.com/v1',
  });

  assert.equal(route.directLive, false);
  assert.equal(route.baseURL, 'https://openrouter.ai/api/v1');
});

test('structured direct transient fallback is Max-only and ordinary-allowlist-bound', async () => {
  await withEnvironment(DIRECT_ENVIRONMENT, async () => {
    await captureFetches(
      async (calls) => {
        const service = new GatewayService(fakeRedis());
        const response = await callStructured(
          service,
          'max',
          answerBody(),
          structuredHeaders('answer'),
        );
        assert.equal(response.status, 200);
        assert.deepEqual(
          calls.map((call) => call.input),
          [
            'https://api.openai.com/v1/chat/completions',
            'https://openrouter.ai/api/v1/chat/completions',
          ],
        );
      },
      (call) =>
        call === 1
          ? new Response('busy', { status: 503 })
          : new Response('{}', { status: 200 }),
    );
  });

  await withEnvironment(
    { ...DIRECT_ENVIRONMENT, GATEWAY_ALLOWED_MODELS: 'qwen/qwen3.8-flash' },
    async () => {
      await captureFetches(
        async (calls) => {
          const service = new GatewayService(fakeRedis());
          const response = await callStructured(
            service,
            'max',
            answerBody(),
            structuredHeaders('answer'),
          );
          assert.equal(response.status, 503);
          assert.deepEqual(calls.map((call) => call.input), [
            'https://api.openai.com/v1/chat/completions',
          ]);
        },
        () => new Response('busy', { status: 503 }),
      );
    },
  );
});

test('gateway controller forwards only the structured workload and phase headers', async () => {
  let captured:
    | {
        body: Record<string, unknown>;
        signal: AbortSignal | undefined;
        headers: Record<string, unknown>;
      }
    | undefined;
  const managedLicense = license('max');
  const gateway = {
    authorize: (authorization: string | undefined) => {
      assert.equal(authorization, 'Bearer signed-license');
      return managedLicense;
    },
    chatCompletions: async (
      verifiedLicense: ReturnType<typeof license>,
      body: Record<string, unknown>,
      signal: AbortSignal | undefined,
      headers: Record<string, unknown>,
    ) => {
      assert.equal(verifiedLicense, managedLicense);
      captured = { body, signal, headers };
      return new Response(
        JSON.stringify({
          usage: { total_tokens: 12 },
          choices: [{ message: { content: '{}' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
    estimateTokens: () => 0,
    recordUsage: async () => undefined,
  };
  let responseStatus: number | undefined;
  let responseBody: unknown;
  const response = {
    on: () => response,
    status: (status: number) => {
      responseStatus = status;
      return response;
    },
    json: (body: unknown) => {
      responseBody = body;
      return response;
    },
  };
  const controller = new GatewayController(
    gateway as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const call = controller.chatCompletions as unknown as (
    authorization: string | undefined,
    workload: string | undefined,
    phase: string | undefined,
    body: Record<string, unknown>,
    response: unknown,
  ) => Promise<void>;
  const body = answerBody({ plan: 'max', dev: true });

  await call.call(
    controller,
    'Bearer signed-license',
    STRUCTURED_WORKLOAD,
    'answer',
    body,
    response,
  );

  assert.equal(captured?.body, body);
  assert.equal(captured?.signal instanceof AbortSignal, true);
  assert.deepEqual(captured?.headers, {
    workload: STRUCTURED_WORKLOAD,
    phase: 'answer',
  });
  assert.equal(responseStatus, 200);
  assert.deepEqual(responseBody, {
    usage: { total_tokens: 12 },
    choices: [{ message: { content: '{}' } }],
  });
});
