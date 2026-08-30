import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPENAI_REALTIME_STT_MODEL,
  REALTIME_RU_TECHNICAL_VOCABULARY,
  RealtimeCommitCorrelator,
  audioDurationSecondsFromPcmBytes,
  buildRealtimeSessionUpdate,
} from './gateway-stt-realtime.protocol';
import { RealtimeSttBridge } from './gateway-stt-realtime.bridge';
import {
  realtimeSafetyIdentifier,
  resolveRealtimeSttUpstream,
} from './gateway-stt-realtime.gateway';

test('Russian realtime session uses only a compact technical vocabulary prompt', () => {
  assert.deepEqual(buildRealtimeSessionUpdate('ru'), {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24_000 },
          transcription: {
            model: 'gpt-4o-mini-transcribe',
            prompt: REALTIME_RU_TECHNICAL_VOCABULARY,
            language: 'ru',
          },
          turn_detection: null,
        },
      },
    },
  });
  const serialized = JSON.stringify(buildRealtimeSessionUpdate('ru'));
  assert.equal(serialized.includes('Русское техническое собеседование'), false);
  assert.equal(serialized.includes('Термины:'), false);
  assert.equal(OPENAI_REALTIME_STT_MODEL, 'gpt-4o-mini-transcribe');
});

test('commit metadata remains attached when Ctrl+Enter binds after OpenAI assigns item id', () => {
  const correlator = new RealtimeCommitCorrelator();

  correlator.enqueue({ clientTurnId: 'turn-1', forceRequestId: undefined });
  assert.deepEqual(correlator.assignItem('item-1'), {
    clientTurnId: 'turn-1',
    forceRequestId: undefined,
  });
  assert.equal(correlator.bindForce('turn-1', 'force-1'), true);
  assert.deepEqual(correlator.complete('item-1'), {
    clientTurnId: 'turn-1',
    forceRequestId: 'force-1',
  });
  assert.equal(correlator.complete('item-1'), undefined);
});

test('completion order is reconciled by item id instead of arrival order', () => {
  const correlator = new RealtimeCommitCorrelator();

  correlator.enqueue({ clientTurnId: 'turn-a', forceRequestId: 'force-a' });
  correlator.enqueue({ clientTurnId: 'turn-b', forceRequestId: 'force-b' });
  correlator.assignItem('item-a');
  correlator.assignItem('item-b');

  assert.equal(correlator.complete('item-b')?.clientTurnId, 'turn-b');
  assert.equal(correlator.complete('item-a')?.clientTurnId, 'turn-a');
});

test('quota duration is derived from received mono PCM bytes', () => {
  assert.equal(audioDurationSecondsFromPcmBytes(48_000, 24_000), 1);
  assert.equal(audioDurationSecondsFromPcmBytes(24_000, 24_000), 0.5);
  assert.equal(audioDurationSecondsFromPcmBytes(0, 24_000), 0);
});

test('bridge streams audio before commit and preserves forced-turn correlation', () => {
  const bridge = new RealtimeSttBridge('ru');
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);

  assert.deepEqual(bridge.acceptAudio(pcm), {
    type: 'input_audio_buffer.append',
    audio: pcm.toString('base64'),
  });
  assert.deepEqual(
    bridge.acceptControl({ type: 'commit', client_turn_id: 'turn-1' }),
    { type: 'input_audio_buffer.commit' },
  );
  assert.deepEqual(
    bridge.acceptUpstream({
      type: 'input_audio_buffer.committed',
      item_id: 'item-1',
    }),
    {
      type: 'turn_committed',
      item_id: 'item-1',
      client_turn_id: 'turn-1',
    },
  );
  assert.equal(
    bridge.acceptControl({
      type: 'bind_force',
      client_turn_id: 'turn-1',
      force_request_id: 'force-1',
    }),
    undefined,
  );
  assert.deepEqual(
    bridge.acceptUpstream({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'Что такое Docker?',
    }),
    {
      type: 'transcript_completed',
      item_id: 'item-1',
      client_turn_id: 'turn-1',
      force_request_id: 'force-1',
      transcript: 'Что такое Docker?',
    },
  );
  assert.equal(bridge.receivedPcmBytes, pcm.length);
});

test('bridge strips the realtime vocabulary echo before forwarding a transcript', () => {
  const bridge = new RealtimeSttBridge('ru');
  bridge.acceptControl({ type: 'commit', client_turn_id: 'turn-echo' });
  bridge.acceptUpstream({
    type: 'input_audio_buffer.committed',
    item_id: 'item-echo',
  });

  assert.deepEqual(
    bridge.acceptUpstream({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-echo',
      transcript: `Как бы вы тестировали этот endpoint? ${REALTIME_RU_TECHNICAL_VOCABULARY}.`,
    }),
    {
      type: 'transcript_completed',
      item_id: 'item-echo',
      client_turn_id: 'turn-echo',
      transcript: 'Как бы вы тестировали этот endpoint?',
    },
  );
});

test('bridge rejects the capitalized vocabulary-only hallucination observed on a silent mic', () => {
  const bridge = new RealtimeSttBridge('ru');
  bridge.acceptControl({ type: 'commit', client_turn_id: 'turn-silent-mic' });
  bridge.acceptUpstream({
    type: 'input_audio_buffer.committed',
    item_id: 'item-silent-mic',
  });

  assert.deepEqual(
    bridge.acceptUpstream({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-silent-mic',
      transcript:
        'Тест-дизайн, тест-дизайна, классы эквивалентности, граничные значения, '
        + 'Python, pytest, Docker, REST API, HTTP, JSON, SQL, Playwright, CI/CD, Kafka, '
        + 'Kubernetes',
    }),
    {
      type: 'transcript_completed',
      item_id: 'item-silent-mic',
      client_turn_id: 'turn-silent-mic',
      transcript: '',
    },
  );
});

test('bridge forwards deltas by item id and rejects arbitrary client events', () => {
  const bridge = new RealtimeSttBridge('ru');
  bridge.acceptControl({ type: 'commit', client_turn_id: 'turn-a' });
  bridge.acceptUpstream({ type: 'input_audio_buffer.committed', item_id: 'item-a' });

  assert.deepEqual(
    bridge.acceptUpstream({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-a',
      delta: 'Docker',
    }),
    {
      type: 'transcript_delta',
      item_id: 'item-a',
      client_turn_id: 'turn-a',
      delta: 'Docker',
    },
  );
  assert.throws(
    () => bridge.acceptControl({ type: 'session.update', session: { type: 'realtime' } }),
    /Unsupported realtime STT control/,
  );
});

test('realtime upstream accepts only a direct OpenAI key and never a compatible proxy key', () => {
  assert.deepEqual(
    resolveRealtimeSttUpstream({
      OPENAI_STT_API_KEY: 'stt-secret',
      OPENAI_STT_BASE_URL: 'https://api.openai.com/v1',
      OPENROUTER_API_KEY: 'must-not-leak',
    }),
    {
      apiKey: 'stt-secret',
      url: 'wss://api.openai.com/v1/realtime?intent=transcription',
    },
  );
  assert.throws(
    () =>
      resolveRealtimeSttUpstream({
        OPENROUTER_API_KEY: 'proxy-key',
        GATEWAY_UPSTREAM_BASE: 'https://proxy.example/v1',
      }),
    /direct OpenAI API key/,
  );
});

test('OpenAI safety identifier is stable and does not expose the license id', () => {
  const first = realtimeSafetyIdentifier('license-private-id');
  assert.equal(first, realtimeSafetyIdentifier('license-private-id'));
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.equal(first.includes('license-private-id'), false);
});

test('late Ctrl+Enter bind is harmless when completion already crossed the gateway', () => {
  const bridge = new RealtimeSttBridge('ru');
  bridge.acceptControl({ type: 'commit', client_turn_id: 'turn-late' });
  bridge.acceptUpstream({
    type: 'input_audio_buffer.committed',
    item_id: 'item-late',
  });
  bridge.acceptUpstream({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item-late',
    transcript: 'Какие техники тест-дизайна вы знаете?',
  });

  assert.equal(
    bridge.acceptControl({
      type: 'bind_force',
      client_turn_id: 'turn-late',
      force_request_id: 'force-late',
    }),
    undefined,
  );
});
