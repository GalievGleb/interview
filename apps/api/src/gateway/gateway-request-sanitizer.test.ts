import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeOpenAiUpstreamBody } from './gateway.service';

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
