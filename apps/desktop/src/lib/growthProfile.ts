export type GrowthRoleId =
  | 'qa-python'
  | 'qa-java'
  | 'qa-manual'
  | 'backend'
  | 'frontend'
  | 'custom';

export type GrowthSelfLevel = 0 | 1 | 2 | 3;

export interface GrowthRoleDefinition {
  label: string;
  core: string[];
  optional: string[];
}

export interface GrowthProfileSetup {
  role: GrowthRoleId | null;
  customRole: string;
  customTopics: string[];
  optional: string[];
  answers: Record<string, GrowthSelfLevel>;
  completed: boolean;
}

export const GROWTH_PROFILE_STORAGE_KEY = 'skillcue.growth-profile.v1';
export const GROWTH_PROFILE_UPDATED_EVENT = 'skillcue:growth-profile-updated';

export const GROWTH_ROLES: Record<Exclude<GrowthRoleId, 'custom'>, GrowthRoleDefinition> = {
  'qa-python': {
    label: 'QA Automation · Python',
    core: ['Python', 'Pytest', 'API-тестирование', 'UI-автоматизация', 'CI/CD', 'Архитектура автотестов'],
    optional: ['Нагрузочное тестирование', 'Мобильное тестирование', 'Безопасность', 'Управление командой'],
  },
  'qa-java': {
    label: 'QA Automation · Java',
    core: ['Java', 'JUnit / TestNG', 'API-тестирование', 'UI-автоматизация', 'CI/CD', 'Архитектура автотестов'],
    optional: ['Нагрузочное тестирование', 'Мобильное тестирование', 'Безопасность', 'Управление командой'],
  },
  'qa-manual': {
    label: 'QA Engineer · Manual',
    core: ['Тест-дизайн', 'API', 'SQL', 'Web', 'Баг-репорты', 'Процессы тестирования'],
    optional: ['Мобильное тестирование', 'Нагрузочное тестирование', 'Безопасность', 'Автоматизация'],
  },
  backend: {
    label: 'Backend-разработчик',
    core: ['Язык и runtime', 'API', 'Базы данных', 'Архитектура', 'Тестирование', 'CI/CD'],
    optional: ['Высокие нагрузки', 'Безопасность', 'Cloud', 'Управление командой'],
  },
  frontend: {
    label: 'Frontend-разработчик',
    core: ['JavaScript / TypeScript', 'Фреймворк', 'Web API', 'Архитектура frontend', 'Тестирование', 'Производительность UI'],
    optional: ['Доступность', 'Mobile Web', 'Node.js', 'Управление командой'],
  },
};

export const GROWTH_LEVELS: Array<{ value: GrowthSelfLevel; label: string }> = [
  { value: 0, label: 'Не работал' },
  { value: 1, label: 'Знаком' },
  { value: 2, label: 'Использую' },
  { value: 3, label: 'Уверенно' },
];

export function emptyGrowthProfile(): GrowthProfileSetup {
  return {
    role: null,
    customRole: '',
    customTopics: [],
    optional: [],
    answers: {},
    completed: false,
  };
}

export function readGrowthProfile(): GrowthProfileSetup {
  try {
    const value = JSON.parse(localStorage.getItem(GROWTH_PROFILE_STORAGE_KEY) || '') as Partial<GrowthProfileSetup>;
    if (!value || typeof value !== 'object') return emptyGrowthProfile();
    const knownRole = typeof value.role === 'string'
      && (value.role === 'custom' || Object.prototype.hasOwnProperty.call(GROWTH_ROLES, value.role));
    return {
      role: knownRole ? value.role as GrowthRoleId : null,
      customRole: typeof value.customRole === 'string' ? value.customRole : '',
      customTopics: Array.isArray(value.customTopics) ? value.customTopics.filter((item): item is string => typeof item === 'string') : [],
      optional: Array.isArray(value.optional) ? value.optional.filter((item): item is string => typeof item === 'string') : [],
      answers: value.answers && typeof value.answers === 'object' ? value.answers : {},
      completed: Boolean(value.completed),
    };
  } catch {
    return emptyGrowthProfile();
  }
}

export function saveGrowthProfile(profile: GrowthProfileSetup): void {
  localStorage.setItem(GROWTH_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  window.dispatchEvent(new Event(GROWTH_PROFILE_UPDATED_EVENT));
}

export function growthRoleLabel(profile: Pick<GrowthProfileSetup, 'role' | 'customRole'>): string {
  if (profile.role === 'custom') return profile.customRole.trim() || 'Другая специализация';
  return profile.role ? GROWTH_ROLES[profile.role].label : '';
}

export function growthRoleTopics(profile: GrowthProfileSetup): string[] {
  if (profile.role === 'custom') return profile.customTopics;
  if (!profile.role) return [];
  const role = GROWTH_ROLES[profile.role];
  return [...role.core, ...profile.optional];
}
