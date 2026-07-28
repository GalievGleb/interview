import { Injectable } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';

export const STT_MODEL = 'gpt-4o-mini-transcribe';

export function wavDurationSeconds(audio: Buffer): number {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const channels = audio.readUInt16LE(22);
  const sampleRate = audio.readUInt32LE(24);
  const bitsPerSample = audio.readUInt16LE(34);
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (!bytesPerSecond) return 0;

  let offset = 12;
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    if (id === 'data') return size / bytesPerSecond;
    offset += 8 + size + (size % 2);
  }
  return 0;
}

@Injectable()
export class GatewaySttService {
  async transcribe(
    apiKey: string,
    baseURL: string,
    audio: Buffer,
    language = 'ru',
  ): Promise<{ text: string; model: string }> {
    const client = new OpenAI({ apiKey, baseURL: baseURL.replace(/\/+$/, '') });
    const file = await toFile(audio, 'utterance.wav', { type: 'audio/wav' });
    const normalizedLanguage =
      language.toLowerCase().startsWith('ru')
        ? 'ru'
        : language.toLowerCase().startsWith('en')
          ? 'en'
          : undefined;
    const result = await client.audio.transcriptions.create({
      file,
      model: STT_MODEL,
      response_format: 'json',
      ...(normalizedLanguage ? { language: normalizedLanguage } : {}),
    });
    return { text: String(result.text ?? '').trim(), model: STT_MODEL };
  }
}
