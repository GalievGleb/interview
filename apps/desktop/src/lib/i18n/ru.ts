/**
 * Русский словарь — источник истины для ключей i18n.
 * Ключи группируются префиксами: nav.*, shell.*, common.*, settings.*
 */
export const ru = {
  // Навигация (Sidebar)
  'nav.group.prep': 'Подготовка',
  'nav.group.live': 'Live',
  'nav.group.context': 'Контекст',
  'nav.group.system': 'Система',
  'nav.home': 'Пульт',
  'nav.prepare': 'Разбор вакансии',
  'nav.interview': 'Live-интервью',
  'nav.documents': 'Резюме и опыт',
  'nav.history': 'История',
  'nav.settings': 'Настройки',
  'nav.search': 'Поиск',

  // Шелл (титул-бар, статусы)
  'shell.liveSession': 'Live-сессия',
  'shell.idle': 'Ожидание',
  'shell.focus': 'Фокус',
  'shell.localPrivate': 'Локально · Приватно',
  'shell.backendConnecting':
    'Подключение к бэкенду… запускается автоматически. Если не поднимается — вручную:',

  // Общие
  'common.copy': 'Копировать',
  'common.delete': 'Удалить',
  'common.cancel': 'Отмена',
  'common.save': 'Сохранить',
  'common.loading': 'Загрузка…',
  'common.language': 'Язык интерфейса',

  // Настройки
  'settings.language.title': 'Язык интерфейса',
  'settings.language.subtitle': 'Меняет язык элементов управления. Ответы AI следуют языку сессии.',

  // Онбординг (первый запуск)
  'onboarding.firstRun': 'Первый запуск',
  'onboarding.skip': 'Пропустить',
  'onboarding.back': 'Назад',
  'onboarding.stt.eyebrow': 'Распознавание речи',
  'onboarding.stt.title': 'Настройте локальное распознавание речи',
  'onboarding.stt.subtitle':
    'SkillCue слушает вопросы интервью и распознаёт их в реальном времени. Выберите, как это работает — по умолчанию всё остаётся на вашем устройстве.',
  'onboarding.stt.whisperTitle': 'Локальный Whisper',
  'onboarding.stt.recommended': 'Рекомендуется',
  'onboarding.stt.whisperDesc.pre': 'Аудио распознаётся локально на вашем устройстве и ',
  'onboarding.stt.whisperDesc.strong': 'не отправляется в облако',
  'onboarding.stt.whisperDesc.post': ' в локальном режиме. Распознавание выполняется на вашем CPU/GPU.',
  'onboarding.stt.expect': 'Чего ожидать',
  'onboarding.stt.expect.offline': 'Работает офлайн после загрузки модели',
  'onboarding.stt.expect.cpu':
    'Использует CPU/GPU — может влиять на батарею, шум вентилятора и производительность',
  'onboarding.stt.expect.download': 'Сначала нужно загрузить локальную речевую модель',
  'onboarding.ethics.strong': 'Этичное использование.',
  'onboarding.ethics.body':
    ' Приложение помогает готовиться и работать на разрешённых созвонах. Не используйте его для обмана интервьюеров и предупреждайте участников о записи, если этого требуют правила.',
  'onboarding.stt.choose': 'Выбрать речевую модель',
  'onboarding.key.eyebrow': 'AI-ключ',
  'onboarding.key.title': 'Подключите AI — это сердце подсказок',
  'onboarding.key.subtitle':
    'Ключ нужен для live-ответов и умной оценки в mock-интервью. Распознавание речи остаётся локальным. Ключ хранится только на вашем устройстве.',
  'onboarding.key.openrouter': 'OpenRouter (рекомендуем)',
  'onboarding.key.openai': 'OpenAI',
  'onboarding.key.hint':
    'Ключ OpenRouter даёт доступ сразу ко многим моделям. Получить его можно на openrouter.ai — займёт пару минут. Можно пропустить и добавить позже в Настройках.',
  'onboarding.key.saveError': 'Не удалось сохранить ключ',
  'onboarding.key.saving': 'Сохраняю…',
  'onboarding.key.save': 'Сохранить и начать',
  'onboarding.key.skipLater': 'Пропустить — добавлю позже',

  // Онбординг — выбор речевой модели (шаг 2)
  'onboarding.sttStep.title': 'Выберите режим распознавания речи',
  'onboarding.sttStep.localTitle': 'Local Whisper — рекомендуется',
  'onboarding.sttStep.b1': 'Аудио распознаётся локально на вашем устройстве',
  'onboarding.sttStep.b2': 'В локальном режиме аудио не отправляется в облако',
  'onboarding.sttStep.b3': 'Использует CPU/GPU во время распознавания',
  'onboarding.sttStep.b4': 'Может влиять на батарею и шум вентилятора',
  'onboarding.sttStep.b5': 'Требует загрузки речевой модели',
  'onboarding.sttStep.autoChoose': 'Выбрать автоматически',
  'onboarding.sttStep.ramUnknown': 'RAM неизвестно',
  'onboarding.sttStep.gpuFound': 'GPU обнаружен',
  'onboarding.sttStep.cpuOnly': 'только CPU',
  'onboarding.sttStep.modelReady': 'Модель загружена — локальный режим готов к работе.',
  'onboarding.sttStep.downloading': 'Загрузка модели…',
  'onboarding.sttStep.downloadNow': 'Скачать модель сейчас (необязательно)',
  'onboarding.sttStep.changeLater': 'Скачать или изменить модель можно позже в Настройках → «Речь и звук».',
  'onboarding.sttStep.downloadError': 'Не удалось начать загрузку',
  'onboarding.sttStep.modelError': 'Не удалось загрузить модель',
  'onboarding.sttStep.privacyLocal':
    'Аудио обрабатывается на вашем устройстве и не отправляется на наши серверы для распознавания.',
  'onboarding.sttStep.resourceLocal':
    'Локальное распознавание использует CPU/GPU и может влиять на батарею, производительность и шум вентилятора.',
  'onboarding.continue': 'Продолжить',

  // Карточки моделей Whisper (метки/описания; данные-фолбэк живут в shared)
  'whisper.fast.label': 'Быстрая',
  'whisper.fast.desc':
    'Для слабых ноутбуков или режима экономии батареи. Минимальное потребление ресурсов и самый быстрый старт, точность на технических терминах ниже. Хорошо подходит для быстрого тестирования или старых устройств.',
  'whisper.balanced.label': 'Сбалансированная',
  'whisper.balanced.desc':
    'Для большинства современных ноутбуков. Хороший баланс скорости и точности, рекомендуется по умолчанию для live-интервью. Хорошо справляется с QA/Python-терминами вместе с коррекцией по глоссарию.',
  'whisper.quality.label': 'Качественная',
  'whisper.quality.desc':
    'Для мощных ноутбуков/десктопов. Точность выше, но больше нагрузка на CPU/GPU и память. Лучше подходит для шумного звука или сложной терминологии.',
  'whisper.max.label': 'Максимальная точность',
  'whisper.max.desc':
    'Максимальная точность на русском языке и технических терминах. Для скорости нужна видеокарта NVIDIA (~1с на вопрос на современной GPU; очень медленно на CPU). Самая большая загрузка. Рекомендуется при наличии GPU.',

  'unit.mb': 'МБ',
  'unit.gbRam': 'ГБ RAM',
} as const;

export type I18nKey = keyof typeof ru;
