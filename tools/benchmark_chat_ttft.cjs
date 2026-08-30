/* Privacy-safe chat time-to-first-token benchmark.
 * Reports timings only and never prints prompts, completions, or credentials.
 */

'use strict';

const [, , mode, repetitionsRaw = '10', requestedModel = 'gpt-4.1-mini'] = process.argv;
if (!['openai', 'openrouter'].includes(mode)) {
  throw new Error('Usage: node benchmark_chat_ttft.cjs <openai|openrouter> [repetitions]');
}

const repetitions = Math.max(1, Number.parseInt(repetitionsRaw, 10) || 1);
const direct = mode === 'openai';
const apiKey = String(
  direct ? process.env.OPENAI_API_KEY || '' : process.env.OPENROUTER_API_KEY || '',
).trim();
const baseUrl = String(
  direct ? 'https://api.openai.com/v1' : process.env.GATEWAY_UPSTREAM_BASE || '',
)
  .trim()
  .replace(/\/+$/, '');
if (!apiKey || !baseUrl) throw new Error(`${mode} credentials are missing`);

const messages = [
  {
    role: 'system',
    content:
      'Ты помощник на техническом собеседовании. Отвечай по-русски, сразу по сути, коротко и точно.',
  },
  {
    role: 'user',
    content:
      'Интервьюер спрашивает про опыт работы с Docker. Дай короткий ответ кандидата: контейнер, образ, изоляция и практическое применение.',
  },
];

async function runOnce() {
  const controller = new AbortController();
  const started = performance.now();
  const payload = {
    model: direct ? requestedModel.replace(/^openai\//, '') : `openai/${requestedModel.replace(/^openai\//, '')}`,
    messages,
    stream: true,
    temperature: 0,
    max_tokens: 180,
    ...(direct ? { stream_options: { include_usage: true } } : { provider: { sort: 'throughput' } }),
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(direct ? {} : { 'HTTP-Referer': 'https://skillcue.app', 'X-Title': 'SkillCue' }),
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('empty stream');
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        const event = JSON.parse(line.slice(6));
        const content = event.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          return Math.round(performance.now() - started);
        }
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

(async () => {
  const values = [];
  let failures = 0;
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    try {
      values.push(await runOnce());
    } catch (error) {
      failures += 1;
      process.stderr.write(`${mode} repetition=${repetition} failed=${error.message}\n`);
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      mode,
      model: requestedModel,
      attempts: repetitions,
      failures,
      minMs: values.length ? Math.min(...values) : null,
      p50Ms: values.length ? percentile(values, 0.5) : null,
      p95Ms: values.length ? percentile(values, 0.95) : null,
      maxMs: values.length ? Math.max(...values) : null,
      samplesMs: values,
    })}\n`,
  );
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
