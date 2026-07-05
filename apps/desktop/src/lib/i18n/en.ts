import type { I18nKey } from './ru';

/** English dictionary — must cover every key from ru (enforced by the type). */
export const en: Record<I18nKey, string> = {
  'nav.group.prep': 'Preparation',
  'nav.group.live': 'Live',
  'nav.group.context': 'Context',
  'nav.group.system': 'System',
  'nav.home': 'Dashboard',
  'nav.prepare': 'Vacancy review',
  'nav.interview': 'Live interview',
  'nav.documents': 'Resume & experience',
  'nav.history': 'History',
  'nav.settings': 'Settings',
  'nav.search': 'Search',

  'shell.liveSession': 'Live session',
  'shell.idle': 'Idle',
  'shell.focus': 'Focus',
  'shell.localPrivate': 'Local · Private',
  'shell.backendConnecting':
    'Connecting to backend… it starts automatically. If it does not come up, run manually:',

  'common.copy': 'Copy',
  'common.delete': 'Delete',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.loading': 'Loading…',
  'common.language': 'Interface language',

  'settings.language.title': 'Interface language',
  'settings.language.subtitle':
    'Changes the UI chrome language. AI answers follow the session language.',
};
