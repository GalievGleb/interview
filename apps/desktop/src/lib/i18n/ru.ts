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

  // Сайдбар
  'sidebar.tagline': 'Пульт интервью',
  'sidebar.quickActions': 'Быстрые действия',
  'sidebar.ready': 'SkillCue готов',
  'sidebar.unavailable': 'Сервис недоступен',
  'sidebar.stealthTitle': 'Скрыть при демонстрации экрана',
  'sidebar.hidden': 'Скрыто',
  'sidebar.visible': 'Видимо',
  'sidebar.taskbarTitle': 'Скрыть из панели задач',
  'sidebar.noTaskbar': 'Без панели',
  'sidebar.inTaskbar': 'В панели',

  // Шелл (титул-бар, статусы)
  'shell.liveSession': 'Live-сессия',
  'shell.idle': 'Ожидание',
  'shell.focus': 'Фокус',
  'shell.localPrivate': 'Локально · Приватно',
  'shell.backendConnecting':
    'Подключение к бэкенду… запускается автоматически. Если не поднимается — вручную:',
  'shell.cloud.speechkit': 'Облако · Яндекс',
  'shell.cloud.deepgram': 'Облако · Deepgram',
  'shell.cloudTitle': 'Аудио распознаётся в облаке провайдера — не на устройстве.',
  'shell.localTitle': 'Распознавание речи работает на вашем устройстве — приватно.',
  'shell.localAria': 'Локально и приватно',
  'shell.backendFailed':
    'Сервис не смог перезапуститься. Перезапустите приложение; если повторится — соберите отчёт в «Настройки → Сообщить о проблеме».',
  'shell.loading': 'Загрузка…',

  // Командная палитра (Ctrl+K)
  'cmd.placeholder': 'Команда или экран…',
  'cmd.empty': 'Ничего не найдено',
  'cmd.on': 'включить',
  'cmd.off': 'выключить',
  'cmd.home': 'Открыть пульт подготовки',
  'cmd.prepare': 'Разобрать вакансию',
  'cmd.interview': 'Перейти: Live-интервью',
  'cmd.documents': 'Открыть резюме и опыт',
  'cmd.history': 'Перейти: История',
  'cmd.settings': 'Перейти: Настройки',
  'cmd.fast': 'Быстрый ответ',
  'cmd.chime': 'Звук «ответ готов»',
  'cmd.speculative': 'Начинать ответ, не дожидаясь конца вопроса',
  'cmd.lang': 'Язык интерфейса',
  'cmd.overlay': 'Открыть overlay',
  'cmd.meeting': 'Dev: разбор разговора',
  'cmd.testlab': 'Dev: тестовая лаборатория',
  'cmd.benchmark': 'Dev: STT-бенчмарк',
  'cmd.diagnostics': 'Dev: диагностика задержек',
  'cmd.licenses': 'Dev: лицензии',

  // Общие
  'common.copy': 'Копировать',
  'common.delete': 'Удалить',
  'common.cancel': 'Отмена',
  'common.save': 'Сохранить',
  'common.loading': 'Загрузка…',
  'common.language': 'Язык интерфейса',
  'common.close': 'Закрыть',

  // Тост обновления
  'update.availablePre': 'Доступно обновление',
  'update.downloadingInline': 'загружается…',
  'update.downloading': 'Загрузка обновления…',
  'update.readyPre': 'Обновление',
  'update.readyPost': 'готово',
  'update.restart': 'Перезапустить',

  // Экран ошибки (ErrorBoundary)
  'error.title': 'Что-то пошло не так',
  'error.body':
    'Экран упал с ошибкой. Перезагрузите приложение — данные хранятся локально и не потеряны.',
  'error.reload': 'Перезагрузить',

  // Статус live-сессии
  'livestatus.idle': 'Ожидание',
  'livestatus.listening': 'Слушаю',
  'livestatus.processing': 'Обработка',
  'livestatus.answerReady': 'Ответ готов',

  // Общее
  'common.error': 'Ошибка',
  'common.open': 'Открыть',
  'common.change': 'Изменить',
  'common.reset': 'Сбросить',

  // Настройки
  'settings.language.title': 'Язык интерфейса',
  'settings.language.subtitle': 'Меняет язык элементов управления. Ответы AI следуют языку сессии.',

  // Настройки — разделы сайдбара
  'settings.section.general': 'Общие',
  'settings.section.ai': 'ИИ и модели',
  'settings.section.speech': 'Речь и звук',
  'settings.section.modes': 'Режимы ответа',
  'settings.section.keybinds': 'Горячие клавиши',
  'settings.section.billing': 'Подписка',
  'settings.section.privacy': 'Приватность',
  'settings.section.developer': 'Разработчик',
  'settings.section.notes': 'Что нового',

  // Настройки — подзаголовки разделов
  'settings.sub.general': 'Версия, тема, язык и поведение оверлея.',
  'settings.sub.ai': 'Модели для live-подсказок и разбора вакансий.',
  'settings.sub.speech': 'Whisper, качество записи и микрофон.',
  'settings.sub.modes': 'Пресеты стиля ответов для оверлея.',
  'settings.sub.keybinds': 'Все сочетания клавиш приложения и оверлея.',
  'settings.sub.billing': 'Тариф и лицензия.',
  'settings.sub.privacy': 'Данные, лицензии open-source, удаление.',
  'settings.sub.developer': 'Отладка STT, задержек и voice-регрессий.',
  'settings.sub.notes': 'История версий SkillCue.',

  // Настройки — сайдбар (справка/выход)
  'settings.report.collecting': 'Собираю отчёт…',
  'settings.report.link': 'Сообщить о проблеме',
  'settings.support.email': 'Написать в поддержку',
  'settings.support.telegram': 'Telegram-чат',
  'settings.quit': 'Выйти из SkillCue',

  // Настройки — Общие
  'settings.version': 'Версия SkillCue',
  'settings.version.desc': 'Обновления скачиваются в фоне и ставятся при перезапуске',
  'settings.update.checking': 'Проверяю…',
  'settings.update.check': 'Проверить обновления',
  'settings.update.unavailable': 'Проверка обновлений доступна в установленном приложении.',
  'settings.update.availablePre': 'Версия',
  'settings.update.availablePost': '— скачивается в фоне.',
  'settings.update.latest': 'У вас последняя версия.',
  'settings.update.failed': 'Не удалось проверить:',
  'settings.theme.title': 'Тема оформления',
  'settings.theme.desc': 'Тёмная, светлая или как в системе',
  'settings.theme.aria': 'Тема',
  'settings.theme.system': 'Системная',
  'settings.theme.dark': 'Тёмная',
  'settings.theme.light': 'Светлая',
  'settings.autolaunch.title': 'Запускать при входе в систему',
  'settings.autolaunch.desc': 'SkillCue откроется автоматически после включения компьютера',
  'settings.autolaunch.aria': 'Автозапуск',
  'settings.langGroup': 'Язык',
  'settings.stt.title': 'Язык распознавания речи',
  'settings.stt.desc': 'Каким языком говорят на собеседовании; дублируется на экране Live',
  'settings.stt.optRu': 'Русский',
  'settings.stt.optAuto': 'Авто (ru+en)',
  'settings.stt.optEn': 'Английский',
  'settings.answerLang.title': 'Язык ответов ИИ',
  'settings.answerLang.desc': 'На каком языке подсказки формулируют ответ; «Авто» — на языке вопроса',
  'settings.answerLang.auto': 'Авто (как вопрос)',
  'settings.answerLang.ru': 'Русский',
  'settings.answerLang.en': 'Английский',
  'settings.overlayGroup': 'Оверлей',
  'settings.stealth.title': 'Скрытность (Undetectability)',
  'settings.stealth.desc': 'Оверлей не виден на скриншотах, записи экрана и демонстрации в Zoom/Meet',
  'settings.stealth.aria': 'Скрытность',
  'settings.useScreen.title': 'Смотреть экран при нехватке контекста',
  'settings.useScreen.desc':
    'Если разговора нет, Подсказка сама делает скриншот и отвечает по нему (чуть медленнее)',
  'settings.useScreen.aria': 'Анализ экрана',
  'settings.hideWidget.title': '«Скрыть» прячет весь виджет',
  'settings.hideWidget.desc':
    'Выключите — кнопка «Скрыть» будет сворачивать панели до пилла, а не прятать всё окно',

  // Настройки — Горячие клавиши
  'settings.kb.note.pre': 'Горячие клавиши работают, когда окно оверлея в фокусе;',
  'settings.kb.note.post':
    '— глобальная и настраивается, если системное сочетание конфликтует с другим приложением.',
  'settings.kb.group.main': 'Основные',
  'settings.kb.group.window': 'Окно оверлея',
  'settings.kb.group.scroll': 'Прокрутка ответа',
  'settings.kb.toggleOverlay': 'Показать / скрыть оверлей',
  'settings.kb.ask': 'Спросить (Подсказка)',
  'settings.kb.clearChat': 'Очистить чат оверлея',
  'settings.kb.stopSession': 'Остановить сессию записи',
  'settings.kb.liveTranscript': 'Живой транскрипт',
  'settings.kb.closeAnswer': 'Закрыть ответ / меню',
  'settings.kb.moveUp': 'Сдвинуть вверх',
  'settings.kb.moveDown': 'Сдвинуть вниз',
  'settings.kb.moveLeft': 'Сдвинуть влево',
  'settings.kb.moveRight': 'Сдвинуть вправо',
  'settings.kb.scrollUp': 'Прокрутить вверх',
  'settings.kb.scrollDown': 'Прокрутить вниз',
  'settings.kb.capturing': 'Нажмите сочетание… (Esc — отмена)',
  'settings.kb.bindError': 'Не удалось назначить сочетание',

  // Настройки — Что нового
  'settings.notes.history': 'История версий',
  'settings.notes.allVersions': 'Все версии',
  'settings.notes.versionAria': 'Версия',

  // Настройки — Приватность
  'settings.privacy.oss.title': 'Открытое ПО и лицензии',
  'settings.privacy.oss.desc': 'Уведомления о лицензиях встроенных open-source компонентов.',
  'settings.privacy.errlog.title': 'Журнал ошибок для отчёта',
  'settings.privacy.errlog.desc':
    'Ошибки копятся локально и уходят, только когда вы сами жмёте «Сообщить о проблеме». Никакой фоновой отправки. Сейчас накоплено:',
  'settings.privacy.errlog.aria': 'Журнал ошибок',
  'settings.privacy.delete.title': 'Удаление данных',
  'settings.privacy.delete.desc':
    'Документы, сессии и история хранятся локально. Можно удалить их одной кнопкой. API-ключи останутся в secure storage.',
  'settings.privacy.delete.btn': 'Удалить все данные',
  'settings.data.deleted': 'Все данные удалены',

  // Настройки — Разработчик
  'settings.dev.title': 'Инструменты разработчика',
  'settings.dev.desc':
    'Эти экраны нужны для отладки STT, latency и voice regression. В обычной подготовке они не участвуют.',
  'settings.dev.testLab': 'Тестовая лаборатория',
  'settings.dev.benchmark': 'STT-бенчмарк',
  'settings.dev.diagnostics': 'Диагностика задержек',
  'settings.dev.meeting': 'Разбор разговора',

  // Настройки — модалка удаления
  'settings.deleteModal.title': 'Удалить все данные?',
  'settings.deleteModal.subtitle': 'Документы, сессии и история будут удалены безвозвратно.',
  'settings.deleteModal.body': 'Это действие нельзя отменить. API-ключи останутся в secure storage.',
  'settings.report.subject': 'SkillCue: проблема',
  'settings.report.body':
    'Опишите, что случилось и в какой момент.\n\nПриложите zip-архив отчёта — он уже открыт в проводнике.',

  // Общее (сохранение)
  'common.saving': 'Сохраняю…',

  // Настройки — Микрофон
  'mic.title': 'Микрофон',
  'mic.desc': 'Устройство для захвата вашего голоса в live-режиме',
  'mic.devicesError': 'Не удалось получить список устройств',
  'mic.permissionDenied': 'Доступ к микрофону отклонён',
  'mic.openError': 'Не удалось открыть микрофон',
  'mic.noDevices': 'Устройства не найдены',
  'mic.fallback': 'Микрофон',
  'mic.stop': 'Стоп',
  'mic.test': 'Проверить',
  'mic.permissionHint': 'Названия устройств скрыты — нужен доступ к микрофону.',
  'mic.grant': 'Разрешить доступ',
  'mic.level': 'Уровень сигнала — говорите в микрофон',

  // Настройки — Модели ИИ
  'aimodels.loadError': 'Не удалось загрузить настройки моделей',
  'aimodels.saved': 'Настройки сохранены',
  'aimodels.saveError': 'Ошибка сохранения',
  'aimodels.loading': 'Загрузка моделей…',
  'aimodels.title': 'Выбор моделей',
  'aimodels.desc':
    '«Автовыбор» — SkillCue сам подбирает модель под задачу. При желании поставьте конкретную.',
  'aimodels.default.label': 'Основная модель Copilot',
  'aimodels.default.desc': 'Для обычных ответов и общих действий SkillCue.',
  'aimodels.coding.label': 'Модель для кода',
  'aimodels.coding.desc':
    'Для задач, где важны код, архитектура, технические объяснения и исправления.',
  'aimodels.fast.label': 'Быстрая live-модель',
  'aimodels.fast.desc':
    'Для коротких ответов в реальном интервью. Здесь важнее скорость, чем глубокий анализ.',
  'aimodels.fast.auto': 'SkillCue выберет быструю модель для live-ответов',
  'aimodels.vacancy.label': 'Модель разбора вакансии',
  'aimodels.vacancy.desc':
    'Для вкладки «Разбор вакансии», Smoke Review и оценки ответов. Ставьте тяжёлую модель: GPT-5.5, GPT-5.4 или Sonnet 4.',
  'aimodels.vacancy.auto':
    'Авто выберет сильную модель для медленного, качественного разбора вакансии',
  'aimodels.deep.label': 'Модель глубокого анализа',
  'aimodels.deep.desc':
    'Для детального анализа, mock feedback, резюме и истории опыта. Не влияет на live-скорость.',
  'aimodels.deep.auto': 'SkillCue выберет reasoning-модель для подробного анализа',
  'aimodels.noChanges': 'Нет изменений',

  // Настройки — Режимы ответа
  'modes.title': 'Режимы ответа',
  'modes.desc':
    'Режим задаёт стиль и контекст подсказок в оверлее: роль, стек, язык, длину ответа. Активный режим можно переключать из меню «…» в оверлее.',
  'modes.noInstruction': 'Без дополнительной инструкции',
  'modes.instructionEmpty': 'Инструкция не задана',
  'modes.done': 'Готово',
  'modes.nameLabel': 'Название режима',
  'modes.instructionLabel': 'Инструкция для модели',
  'modes.instructionPlaceholder':
    'Например: «Я Python-разработчик, собеседуюсь на middle. Отвечай кратко, от первого лица, с примерами из Django».',
  'modes.newPlaceholder': 'Название нового режима (например, «Frontend-собес»)',
  'modes.create': 'Создать режим',
  'modes.general': 'Общий',

  // Настройки — Распознавание речи (STT)
  'stt.whisper.tagline':
    'Приватно и бесплатно: аудио не покидает устройство. Задержка зависит от железа.',
  'stt.whisper.privacy': 'Звук обрабатывается локально.',
  'stt.deepgram.tagline': 'Самый быстрый: слова на экране через ~300 мс. ~0.66₽/мин, нужен API-ключ.',
  'stt.deepgram.privacy': 'Аудио уходит в облако Deepgram (США).',
  'stt.deepgram.keyPlaceholder': 'Deepgram API key',
  'stt.speechkit.label': 'Яндекс SpeechKit v3',
  'stt.speechkit.tagline':
    'Лучшее распознавание русского. ~0.65₽/мин, оплата в рублях, нужен API-ключ.',
  'stt.speechkit.privacy': 'Аудио уходит в Яндекс Cloud (Россия).',
  'stt.speechkit.keyPlaceholder': 'API-ключ сервисного аккаунта Яндекс Cloud',
  'stt.skModel.general': 'Стабильная',
  'stt.skModel.rc': 'Кандидат (rc)',
  'stt.loadError': 'Не удалось загрузить настройки STT',
  'stt.saveError': 'Не удалось сохранить настройки',
  'stt.downloadError': 'Не удалось начать загрузку',
  'stt.deleteError': 'Не удалось удалить модель',
  'stt.loading': 'Загрузка настроек распознавания речи…',
  'stt.keySaved': 'Ключ сохранён. Live-распознавание переключится со следующей сессии.',
  'stt.saveKeyError': 'Не удалось сохранить ключ',
  'stt.title': 'Распознавание речи (STT)',
  'stt.desc': 'Движок live-транскрипции: локальный (приватно) или облачный (быстрее и точнее).',
  'stt.badge.private': 'Приватно',
  'stt.badge.keySaved': 'Ключ сохранён',
  'stt.badge.keyNeeded': 'Нужен ключ',
  'stt.apiKey': 'API-ключ',
  'stt.saved': 'сохранён',
  'stt.saveKey': 'Сохранить ключ',
  'stt.replaceKey': 'Заменить ключ',
  'stt.noKeyWarn':
    'Без ключа live-сессия покажет ошибку и подскажет вернуться на Local Whisper.',
  'stt.skModel.title': 'Модель распознавания',
  'stt.skModel.desc':
    'Стабильная (general) — проверенная. Кандидат (general:rc) первым получает улучшения качества русского, но Яндекс обновляет его без предупреждения.',
  'stt.skModel.aria': 'Модель SpeechKit',
  'stt.alert.local':
    'Распознавание: Local Whisper — аудио распознаётся локально и не отправляется в облако.',
  'stt.alert.cloudPre': 'Распознавание:',
  'stt.streaming.title': 'Потоковые модели',
  'stt.partial.label': 'Промежуточная модель (live-субтитры)',
  'stt.partial.hint': 'Быстрые обновления пока вы говорите (~500 мс).',
  'stt.final.label': 'Финальная модель (после паузы)',
  'stt.final.hint': 'Точнее, когда фраза уже закончена.',
  'stt.localModel': 'Локальная модель',
  'stt.meter.speed': 'Скорость',
  'stt.meter.acc': 'Точность',
  'stt.meter.res': 'Ресурсы',
  'stt.model.ready': 'Загружена · Готова',
  'stt.model.notDownloaded': 'Не загружена',
  'stt.retry': 'Повторить',
  'stt.download': 'Скачать',
  'stt.device.title': 'Вычислительное устройство',
  'stt.device.desc': 'Авто выбирает GPU при наличии, иначе CPU.',
  'stt.device.auto': 'Авто',
  'stt.validation': 'Проверка',
  'stt.runBenchmark': 'Запустить STT-бенчмарк',
  'stt.openDiagnostics': 'Открыть диагностику',

  // Общее (проверка)
  'common.checking': 'Проверяю…',

  // Тарифы (billing) — названия и фичи
  'billing.plan.basic.name': 'Базовый — подготовка',
  'billing.plan.max.name': 'Максимум — всё включено',
  'billing.feat.mock': 'Мок-собеседования с разбором',
  'billing.feat.vacancy': 'Анализ вакансий и слабых тем',
  'billing.feat.kb': 'База знаний и тренировка ответов',
  'billing.feat.aiPrep': 'Месячный объём ИИ для подготовки',
  'billing.feat.live': 'Live-подсказки и оверлей',
  'billing.feat.screen': 'Анализ экрана и скрытность',
  'billing.feat.allBasic': 'Всё из «Базового»',
  'billing.feat.liveDuring': 'Live-подсказки во время собеседования',
  'billing.feat.overlay': 'Оверлей поверх Zoom/Meet + скрытность',
  'billing.feat.screenshot': 'Анализ экрана (скриншот → подсказка)',
  'billing.feat.aiMax': 'Увеличенный объём ИИ — хватит на активный поиск',

  // Настройки — Тариф (PlanPicker)
  'plan.title': 'Тариф',
  'plan.current': 'Текущий план:',
  'plan.max': 'Максимум',
  'plan.basic': 'Базовый',
  'plan.trialInfo': 'Пробный доступ: 15 минут live и небольшой лимит на подготовку',
  'plan.periodAria': 'Период оплаты',
  'plan.monthly': 'Месяц',
  'plan.yearly': 'Год · −17%',
  'plan.currentBadge': 'Текущий',
  'plan.popular': 'Популярный',
  'plan.perMonth': ' / месяц',
  'plan.perYear': ' / год',
  'plan.yourCurrent': 'Ваш текущий план',
  'plan.checkoutNote':
    'Оплата откроется в браузере. После оплаты лицензионный ключ придёт на почту — активируйте его в карточке «Лицензия» ниже.',
  'plan.goToCheckout': 'Перейти к оплате',
  'plan.switch': 'Сменить план',
  'plan.subscribe': 'Оформить',

  // Настройки — Лицензия (LicenseCard)
  'license.plan.trial': 'Пробный доступ',
  'license.plan.basic': 'Basic — подготовка',
  'license.plan.max': 'Max — всё включено',
  'license.activated': 'Лицензия активирована',
  'license.activateError': 'Не удалось активировать ключ',
  'license.trialLeftPre': 'Trial · осталось',
  'license.trialLeftPost': 'мин live',
  'license.trialEnded': 'Пробные минуты закончились',
  'license.title': 'Лицензия',
  'license.issuedTo': 'Оформлена на',
  'license.basicUpsell':
    ' Live-режим и оверлей доступны на тарифе max — напишите нам для апгрейда.',
  'license.trialPrompt':
    'Попробуйте live-режим: 15 минут бесплатно, плюс небольшой лимит на подготовку. Дальше — по лицензии.',
  'license.expiredPrompt':
    'Пробные live-минуты израсходованы: live приостановлен, подготовка работает в рамках лимита. Введите ключ, чтобы продолжить.',
  'license.activate': 'Активировать',
  'license.monthLimit': 'Месячный лимит тарифа исчерпан — AI-функции возобновятся 1-го числа.',

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
