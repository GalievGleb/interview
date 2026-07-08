/**
 * Чистые хелперы для проксирования Yandex SpeechKit v3 (RecognizeStreaming).
 * Зеркалит apps/api-py/app/services/stt/speechkit_stream.py — держим оба моста
 * в одном поведении (тот же баг с "auto" был найден и исправлен там же).
 */
import { stt as sttRuntime } from '@yandex-cloud/nodejs-sdk/ai-stt-v3';
import type { AlternativeUpdate, StreamingOptions } from './yandex-stt-types';

export const YANDEX_STT_ENDPOINT = 'stt.api.cloud.yandex.net:443';

/**
 * Наш код языка → whitelist SpeechKit v3. Для авто/multi отдаём обе локали:
 * SpeechKit сам выбирает язык из WHITELIST. Литерала "auto" в API v3 нет.
 */
export function languageCodes(language: string): string[] {
  const lang = (language ?? '').toLowerCase();
  if (lang.startsWith('ru')) return ['ru-RU'];
  if (lang.startsWith('en')) return ['en-US'];
  return ['ru-RU', 'en-US'];
}

export function buildSessionOptions(language: string, sampleRateHertz: number): StreamingOptions {
  return {
    recognitionModel: {
      model: 'general',
      audioFormat: {
        rawAudio: {
          audioEncoding: sttRuntime.RawAudio_AudioEncoding.LINEAR16_PCM,
          sampleRateHertz,
          audioChannelCount: 1,
        },
      },
      textNormalization: {
        textNormalization:
          sttRuntime.TextNormalizationOptions_TextNormalization.TEXT_NORMALIZATION_ENABLED,
        profanityFilter: false,
        literatureText: true,
        phoneFormattingMode:
          sttRuntime.TextNormalizationOptions_PhoneFormattingMode.PHONE_FORMATTING_MODE_DISABLED,
      },
      languageRestriction: {
        restrictionType: sttRuntime.LanguageRestrictionOptions_LanguageRestrictionType.WHITELIST,
        languageCode: languageCodes(language),
      },
      audioProcessingType: sttRuntime.RecognitionModelOptions_AudioProcessingType.REAL_TIME,
    },
  };
}

/** Текст первого варианта распознавания события (partial/final/refinement). */
export function alternativesText(update: AlternativeUpdate | undefined): string {
  const text = update?.alternatives?.[0]?.text ?? '';
  return text.trim();
}
