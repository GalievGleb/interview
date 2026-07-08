/**
 * Наши локальные типы для '@yandex-cloud/nodejs-sdk/ai-stt-v3' (speechkit.stt.v3).
 *
 * Пакет типизирован (проверено: dist/generated/.../stt.d.ts, stt_service.d.ts),
 * но его subpath-экспорт не резолвится TS-классик-резолвером (см.
 * yandex-stt-v3.d.ts). Эти интерфейсы — точная копия нужных нам полей реальных
 * сгенерированных типов пакета (camelCase, ts-proto), сверено вручную построчно.
 * Значения enum'ов приходят из самого пакета в рантайме (см. yandex-stt.util.ts) —
 * здесь только форма объектов для компилятора.
 */

export interface RawAudio {
  audioEncoding: number; // RawAudio_AudioEncoding — берём значение из пакета
  sampleRateHertz: number;
  audioChannelCount: number;
}

export interface AudioFormatOptions {
  rawAudio?: RawAudio;
}

export interface TextNormalizationOptions {
  textNormalization: number; // TextNormalizationOptions_TextNormalization
  profanityFilter: boolean;
  literatureText: boolean;
  phoneFormattingMode: number; // TextNormalizationOptions_PhoneFormattingMode
}

export interface LanguageRestrictionOptions {
  restrictionType: number; // LanguageRestrictionOptions_LanguageRestrictionType
  languageCode: string[];
}

export interface RecognitionModelOptions {
  model: string;
  audioFormat?: AudioFormatOptions;
  textNormalization?: TextNormalizationOptions;
  languageRestriction?: LanguageRestrictionOptions;
  audioProcessingType: number; // RecognitionModelOptions_AudioProcessingType
}

export interface StreamingOptions {
  recognitionModel?: RecognitionModelOptions;
}

export interface AudioChunk {
  data: Buffer;
}

export interface StreamingRequest {
  sessionOptions?: StreamingOptions;
  chunk?: AudioChunk;
}

export interface Word {
  text: string;
  startTimeMs: number;
  endTimeMs: number;
}

export interface Alternative {
  words: Word[];
  text: string;
}

export interface AlternativeUpdate {
  alternatives: Alternative[];
}

export interface EouUpdate {
  timeMs: number;
}

export interface FinalRefinement {
  finalIndex: number;
  normalizedText?: AlternativeUpdate;
}

export interface StreamingResponse {
  partial?: AlternativeUpdate;
  final?: AlternativeUpdate;
  eouUpdate?: EouUpdate;
  finalRefinement?: FinalRefinement;
}
