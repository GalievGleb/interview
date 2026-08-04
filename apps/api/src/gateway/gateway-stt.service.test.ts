import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANSWER_STT_MODEL,
  ANSWER_UPLOAD_LIMITS,
  STT_MODEL,
  answerWavDurationSeconds,
  buildAnswerTranscriptionForm,
  parseAnswerTranscriptionGuidance,
} from './gateway-stt.service';
import { GatewaySttUploadGuard } from './gateway-stt-upload.guard';

function pcm16Wav(options: {
  sampleRate?: number;
  channels?: number;
  seconds?: number;
  silence?: boolean;
} = {}): Buffer {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 1;
  const seconds = options.seconds ?? 0.1;
  const dataBytes = Math.round(sampleRate * channels * 2 * seconds);
  const output = Buffer.alloc(44 + dataBytes, options.silence ? 0 : 1);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * 2, 28);
  output.writeUInt16LE(channels * 2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataBytes, 40);
  return output;
}

test('answer form uses gpt-transcribe while live keeps Mini', () => {
  const form = buildAnswerTranscriptionForm(Buffer.from('RIFF mock WAVE audio'), {
    prompt: 'Техническое интервью. Вопрос: что проверяете кроме 200?',
    keywords: ['API', 'JSON'],
    languages: ['ru', 'en'],
  });

  assert.equal(ANSWER_STT_MODEL, 'gpt-transcribe');
  assert.equal(STT_MODEL, 'gpt-4o-mini-transcribe');
  assert.equal(form.get('model'), ANSWER_STT_MODEL);
  assert.equal(
    form.get('prompt'),
    'Техническое интервью. Вопрос: что проверяете кроме 200?',
  );
  assert.deepEqual(form.getAll('keywords[]'), ['API', 'JSON']);
  assert.deepEqual(form.getAll('languages[]'), ['ru', 'en']);
  assert.ok(form.get('file') instanceof Blob);
  assert.deepEqual(ANSWER_UPLOAD_LIMITS, {
    fileSize: 25 * 1024 * 1024,
    files: 1,
    fields: 3,
    // Busboy raises partsLimit when the boundary count reaches the limit,
    // so four expected parts need one slot of headroom.
    parts: 5,
    fieldSize: 8 * 1024,
  });
});

test('gateway guidance parser preserves bounded literal terms', () => {
  assert.deepEqual(
    parseAnswerTranscriptionGuidance(
      '  Техническое интервью. Вопрос: API?  ',
      JSON.stringify(['API', 'JSON', 'API']),
      JSON.stringify(['ru', 'en']),
    ),
    {
      prompt: 'Техническое интервью. Вопрос: API?',
      keywords: ['API', 'JSON'],
      languages: ['ru', 'en'],
    },
  );
});

test('gateway guidance parser rejects unsafe keyword characters', () => {
  assert.throws(
    () =>
      parseAnswerTranscriptionGuidance(
        'Вопрос',
        JSON.stringify(['bad<hint>']),
        JSON.stringify(['ru']),
      ),
    /Invalid transcription keywords/,
  );
});

test('answer WAV validation accepts only complete <=120s mono PCM16 audio', () => {
  assert.ok(Math.abs(answerWavDurationSeconds(pcm16Wav()) - 0.1) < 0.001);
  assert.equal(answerWavDurationSeconds(pcm16Wav({ channels: 2 })), 0);
  assert.equal(answerWavDurationSeconds(pcm16Wav().subarray(0, -2)), 0);
  assert.equal(answerWavDurationSeconds(pcm16Wav({ sampleRate: 8_000, seconds: 121 })), 0);
  assert.equal(answerWavDurationSeconds(pcm16Wav({ silence: true })), 0);

  const notWave = pcm16Wav();
  notWave.write('NOPE', 8, 'ascii');
  assert.equal(answerWavDurationSeconds(notWave), 0);
});

test('answer upload guard authorizes and checks quota before multipart parsing', async () => {
  const events: string[] = [];
  const license = { id: 'license-1' };
  const request: { headers: { authorization: string }; skillcueSttLicense?: unknown } = {
    headers: { authorization: 'Bearer signed-license' },
  };
  const guard = new GatewaySttUploadGuard(
    {
      authorize(auth: string | undefined) {
        events.push(`authorize:${auth}`);
        return license;
      },
    } as never,
    {
      async assertCanStart(value: unknown) {
        events.push(`quota:${value === license}`);
      },
    } as never,
  );

  const allowed = await guard.canActivate({
    switchToHttp: () => ({ getRequest: () => request }),
  } as never);

  assert.equal(allowed, true);
  assert.deepEqual(events, ['authorize:Bearer signed-license', 'quota:true']);
  assert.equal(request.skillcueSttLicense, license);
});
