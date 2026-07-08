/**
 * Ambient-шим для '@yandex-cloud/nodejs-sdk/ai-stt-v3'.
 *
 * Пакет реально экспортирует этот subpath в рантайме (package.json "exports":
 * "./ai-stt-v3" -> "./dist/clients/ai-stt-v3/index.js" — проверено, файл
 * существует). Но у нас moduleResolution "node" (classic) — TS с ним не умеет
 * читать типы из "exports"-подпутей без "types"-условия и падает с TS2307,
 * хотя рантайм-резолюция полностью рабочая. Смена moduleResolution на
 * "bundler"/"node16" затронула бы весь apps/api (требует module: esnext/
 * node16), поэтому вместо этого — точечный шим (any на границе импорта);
 * реальная форма значений задана нашими интерфейсами в yandex-stt-types.ts,
 * сверенными вручную с настоящими .d.ts пакета.
 */
declare module '@yandex-cloud/nodejs-sdk/ai-stt-v3' {
  export const stt: any;
  export const sttService: any;
}
