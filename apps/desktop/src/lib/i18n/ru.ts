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
} as const;

export type I18nKey = keyof typeof ru;
