/* Privacy-safe OpenAI Realtime transcription latency probe.
 *
 * Reads raw mono PCM16/24 kHz, reports only timings and whether a non-empty
 * transcript arrived. OPENAI_API_KEY is read from the process environment and
 * is never printed.
 */

'use strict';

const fs = require('node:fs');
const WebSocket = require('ws');

const [, , pcmPath, repetitionsRaw = '5', ...models] = process.argv;
if (!pcmPath || models.length === 0) {
  throw new Error(
    'Usage: node benchmark_realtime_transcription.cjs <pcm24k> <repetitions> <model...>',
  );
}
const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is missing');

const repetitions = Math.max(1, Number.parseInt(repetitionsRaw, 10) || 1);
const pcm = fs.readFileSync(pcmPath);
const audio = pcm.toString('base64');

function sessionUpdate(model) {
  const transcription = {
    model,
    prompt: 'Русское техническое собеседование по разработке и тестированию.',
  };
  if (model === 'gpt-live-transcribe') {
    Object.assign(transcription, {
      keywords: ['Python', 'pytest', 'Docker', 'REST API', 'SQL', 'Kafka'],
      languages: ['ru', 'en'],
      delay: 'low',
    });
  } else {
    transcription.language = 'ru';
  }
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription,
          turn_detection: null,
        },
      },
    },
  };
}

async function runOnce(model) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(
      'wss://api.openai.com/v1/realtime?intent=transcription',
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    let committedAt = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('timeout')), 20000);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    }

    socket.on('open', () => socket.send(JSON.stringify(sessionUpdate(model))));
    socket.on('error', (error) => finish(error));
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'error') {
        finish(new Error(String(event.error?.message || 'realtime error')));
        return;
      }
      if (event.type === 'session.updated' && !committedAt) {
        socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
        committedAt = performance.now();
        socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        return;
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        finish(null, {
          latencyMs: Math.round(performance.now() - committedAt),
          nonEmpty: Boolean(String(event.transcript || '').trim()),
        });
      }
    });
  });
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

(async () => {
  for (const model of models) {
    const values = [];
    let failures = 0;
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      try {
        const result = await runOnce(model);
        if (!result.nonEmpty) throw new Error('empty transcript');
        values.push(result.latencyMs);
      } catch (error) {
        failures += 1;
        process.stderr.write(`${model} repetition=${repetition} failed=${error.message}\n`);
      }
    }
    const summary = {
      model,
      attempts: repetitions,
      failures,
      minMs: values.length ? Math.min(...values) : null,
      p50Ms: values.length ? percentile(values, 0.5) : null,
      p95Ms: values.length ? percentile(values, 0.95) : null,
      maxMs: values.length ? Math.max(...values) : null,
      samplesMs: values,
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
