import { BadRequestException, Injectable } from '@nestjs/common';
import OpenAI, { toFile } from 'openai';

export const STT_MODEL = 'gpt-4o-mini-transcribe';
export const ANSWER_STT_MODEL = 'gpt-transcribe';
export const LIVE_STT_REQUEST_OPTIONS = { maxRetries: 3, timeout: 30_000 } as const;

export interface ManagedSttCredentials {
  apiKey: string;
  baseURL: string;
}

/** Keep an OpenAI-compatible base URL paired with the key issued by that service. */
export function resolveManagedSttCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): ManagedSttCredentials {
  const explicitBase = String(environment.OPENAI_STT_BASE_URL ?? '').trim();
  const sharedBase = String(environment.GATEWAY_UPSTREAM_BASE ?? '').trim();
  const baseURL = explicitBase || sharedBase || 'https://api.openai.com/v1';
  const explicitKey = String(environment.OPENAI_STT_API_KEY ?? '').trim();
  const openAiKey = String(environment.OPENAI_API_KEY ?? '').trim();
  const sharedKey = String(environment.OPENROUTER_API_KEY ?? '').trim();
  const directOpenAi = /^https:\/\/api\.openai\.com(?:\/|$)/i.test(baseURL);
  const apiKey = explicitKey || (directOpenAi ? openAiKey || sharedKey : sharedKey || openAiKey);
  return { apiKey, baseURL };
}
export const ANSWER_UPLOAD_LIMITS = {
  fileSize: 25 * 1024 * 1024,
  files: 1,
  fields: 3,
  // Busboy emits partsLimit when the count reaches the configured ceiling.
  // The expected file + three fields therefore need one slot of headroom.
  parts: 5,
  fieldSize: 8 * 1024,
} as const;
const MAX_ANSWER_PROMPT_CHARS = 1_200;
const MAX_ANSWER_KEYWORDS = 32;
const MAX_ANSWER_KEYWORD_CHARS = 64;

export interface AnswerTranscriptionGuidance {
  prompt: string;
  keywords: string[];
  languages: string[];
}

function parseStringArray(raw: string | undefined, field: 'keywords' | 'languages'): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '[]');
  } catch {
    throw new BadRequestException(`Invalid transcription ${field}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new BadRequestException(`Invalid transcription ${field}`);
  }
  return parsed;
}

export function parseAnswerTranscriptionGuidance(
  rawPrompt: string | undefined,
  rawKeywords: string | undefined,
  rawLanguages: string | undefined,
): AnswerTranscriptionGuidance {
  const prompt = String(rawPrompt ?? '').replace(/\s+/g, ' ').trim();
  if (!prompt || prompt.length > MAX_ANSWER_PROMPT_CHARS) {
    throw new BadRequestException('Invalid transcription prompt');
  }

  const keywords: string[] = [];
  const seenKeywords = new Set<string>();
  const parsedKeywords = parseStringArray(rawKeywords, 'keywords');
  if (parsedKeywords.length > MAX_ANSWER_KEYWORDS) {
    throw new BadRequestException('Invalid transcription keywords');
  }
  for (const rawKeyword of parsedKeywords) {
    const keyword = rawKeyword.trim();
    if (
      !keyword ||
      keyword.length > MAX_ANSWER_KEYWORD_CHARS ||
      /[<>\r\n]/.test(keyword)
    ) {
      throw new BadRequestException('Invalid transcription keywords');
    }
    const key = keyword.toLocaleLowerCase();
    if (!seenKeywords.has(key)) {
      seenKeywords.add(key);
      keywords.push(keyword);
    }
  }

  const languages: string[] = [];
  const seenLanguages = new Set<string>();
  for (const rawLanguage of parseStringArray(rawLanguages, 'languages')) {
    const language = rawLanguage.trim().toLocaleLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(language) || seenLanguages.has(language)) continue;
    seenLanguages.add(language);
    languages.push(language);
  }
  if (languages.length === 0 || languages.length > 4) {
    throw new BadRequestException('Invalid transcription languages');
  }

  return { prompt, keywords, languages };
}

export function buildAnswerTranscriptionForm(
  audio: Buffer,
  guidance: AnswerTranscriptionGuidance,
): FormData {
  const form = new FormData();
  form.append('model', ANSWER_STT_MODEL);
  form.append('response_format', 'json');
  form.append('prompt', guidance.prompt);
  for (const keyword of guidance.keywords) form.append('keywords[]', keyword);
  for (const language of guidance.languages) form.append('languages[]', language);
  form.append(
    'file',
    new Blob([new Uint8Array(audio)], { type: 'audio/wav' }),
    'answer.wav',
  );
  return form;
}

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

/** Strict validator for the one-file mock-answer contract. */
export function answerWavDurationSeconds(audio: Buffer): number {
  try {
    if (
      audio.length < 44 ||
      audio.toString('ascii', 0, 4) !== 'RIFF' ||
      audio.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      return 0;
    }
    const declaredEnd = audio.readUInt32LE(4) + 8;
    if (declaredEnd !== audio.length) return 0;

    let format: {
      audioFormat: number;
      channels: number;
      sampleRate: number;
      byteRate: number;
      blockAlign: number;
      bitsPerSample: number;
    } | null = null;
    let frames: Buffer | null = null;
    let offset = 12;
    while (offset + 8 <= declaredEnd) {
      const id = audio.toString('ascii', offset, offset + 4);
      const size = audio.readUInt32LE(offset + 4);
      const payloadStart = offset + 8;
      const payloadEnd = payloadStart + size;
      const paddedEnd = payloadEnd + (size % 2);
      if (payloadEnd > declaredEnd || paddedEnd > declaredEnd) return 0;
      if (id === 'fmt ') {
        if (format || size < 16) return 0;
        format = {
          audioFormat: audio.readUInt16LE(payloadStart),
          channels: audio.readUInt16LE(payloadStart + 2),
          sampleRate: audio.readUInt32LE(payloadStart + 4),
          byteRate: audio.readUInt32LE(payloadStart + 8),
          blockAlign: audio.readUInt16LE(payloadStart + 12),
          bitsPerSample: audio.readUInt16LE(payloadStart + 14),
        };
      } else if (id === 'data') {
        if (frames) return 0;
        frames = audio.subarray(payloadStart, payloadEnd);
      }
      offset = paddedEnd;
    }

    if (offset !== declaredEnd || !format || !frames) return 0;
    if (
      format.audioFormat !== 1 ||
      format.channels !== 1 ||
      format.bitsPerSample !== 16 ||
      format.blockAlign !== 2 ||
      format.byteRate !== format.sampleRate * 2 ||
      format.sampleRate < 8_000 ||
      format.sampleRate > 96_000 ||
      frames.length === 0 ||
      frames.length % format.blockAlign !== 0 ||
      !frames.some((value) => value !== 0)
    ) {
      return 0;
    }
    const duration = frames.length / format.byteRate;
    return duration > 0 && duration <= 120 ? duration : 0;
  } catch {
    return 0;
  }
}

@Injectable()
export class GatewaySttService {
  async transcribe(
    apiKey: string,
    baseURL: string,
    audio: Buffer,
    language = 'ru',
  ): Promise<{ text: string; model: string }> {
    const client = new OpenAI({
      apiKey,
      baseURL: baseURL.replace(/\/+$/, ''),
      ...LIVE_STT_REQUEST_OPTIONS,
    });
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

  async transcribeAnswer(
    apiKey: string,
    baseURL: string,
    audio: Buffer,
    guidance: AnswerTranscriptionGuidance,
  ): Promise<{ text: string; model: string }> {
    const response = await fetch(
      `${baseURL.replace(/\/+$/, '')}/audio/transcriptions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: buildAnswerTranscriptionForm(audio, guidance),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      throw new Error(`OpenAI answer STT ${response.status}: ${detail}`);
    }
    const result = (await response.json()) as { text?: string };
    return { text: String(result.text ?? '').trim(), model: ANSWER_STT_MODEL };
  }
}
