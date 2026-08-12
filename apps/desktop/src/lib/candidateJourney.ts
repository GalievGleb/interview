export type CandidatePath = 'vacancy' | 'profile';
export type CandidateJourneyStepStatus = 'done' | 'current' | 'upcoming';

export interface CandidateJourneyStep {
  id: string;
  label: string;
  description: string;
  status: CandidateJourneyStepStatus;
}

export interface CandidateJourneyAction {
  label: string;
  to: string;
}

export interface CandidateJourneySignals {
  selectedPath: CandidatePath | null;
  hasVacancy: boolean;
  hasResume: boolean;
  hasAnalysis: boolean;
  practiceAnswers: number;
  practiceQuestions: number;
  practiceCompleted: boolean;
  hasApplication?: boolean;
  hasEmployerResponse?: boolean;
  hasGrowthRole: boolean;
  hasGrowthProfile: boolean;
  hasEvidence: boolean;
  activeSessionId?: string;
  activeVacancyUrl?: string;
  activeResumeTitle?: string;
}

export interface CandidateJourney {
  path: CandidatePath | null;
  pathLabel: string;
  headline: string;
  body: string;
  action: CandidateJourneyAction;
  secondaryAction?: CandidateJourneyAction;
  steps: CandidateJourneyStep[];
  currentStep: number;
}

export interface StoredGrowthProfile {
  role?: string | null;
  completed?: boolean;
}

export const CANDIDATE_PATH_STORAGE_KEY = 'skillcue.candidate-path.v1';

function statuses(done: boolean[]): CandidateJourneyStepStatus[] {
  let waitingForPrerequisite = false;

  return done.map((isDone) => {
    if (waitingForPrerequisite) return 'upcoming';
    if (isDone) return 'done';
    waitingForPrerequisite = true;
    return 'current';
  });
}

function vacancyJourney(input: CandidateJourneySignals): CandidateJourney {
  const done = [
    input.hasVacancy,
    input.hasResume,
    input.hasAnalysis,
    input.practiceCompleted,
    Boolean(input.hasApplication),
    Boolean(input.hasApplication && input.hasEmployerResponse),
  ];
  const currentStep = Math.max(0, done.findIndex((value) => !value));
  const stepStatuses = statuses(done);
  const steps: CandidateJourneyStep[] = [
    { id: 'vacancy', label: 'Вакансия', description: 'Что требуется от кандидата', status: stepStatuses[0] },
    { id: 'resume', label: 'Резюме', description: 'Ваш реальный опыт', status: stepStatuses[1] },
    { id: 'match', label: 'Сопоставление', description: 'Сильные стороны и разрывы', status: stepStatuses[2] },
    { id: 'practice', label: 'Практика', description: 'Вопросы по найденным разрывам', status: stepStatuses[3] },
    { id: 'apply', label: 'Отклик', description: 'Проверка и явная отправка', status: stepStatuses[4] },
    { id: 'response', label: 'Ответ HR', description: 'Диалог или приглашение', status: stepStatuses[5] },
  ];

  if (!input.hasVacancy) {
    return {
      path: 'vacancy',
      pathLabel: 'Есть вакансия',
      headline: 'Добавьте вакансию — она задаст цель подготовки.',
      body: 'SkillCue выделит требования и вероятные вопросы. Затем вы добавите резюме, чтобы увидеть разрыв именно относительно вашего опыта.',
      action: { label: 'Добавить вакансию', to: '/prepare' },
      steps,
      currentStep,
    };
  }
  if (!input.hasResume) {
    return {
      path: 'vacancy',
      pathLabel: 'Есть вакансия',
      headline: 'Теперь добавьте резюме, чтобы разбор стал личным.',
      body: input.hasAnalysis
        ? 'Вакансия уже разобрана без вашего опыта. Добавьте резюме — следующий разбор покажет, что подтверждено, где не хватает примеров и о чём могут спросить.'
        : 'Без резюме SkillCue видит требования, но не может честно отделить ваши сильные стороны от пробелов.',
      action: {
        label: 'Добавить резюме',
        to: input.activeSessionId
          ? `/documents?next=prepare&session=${encodeURIComponent(input.activeSessionId)}`
          : '/documents?next=prepare',
      },
      secondaryAction: input.hasAnalysis
        ? { label: 'Открыть текущий разбор', to: input.activeSessionId ? `/prepare?session=${input.activeSessionId}` : '/prepare' }
        : undefined,
      steps,
      currentStep,
    };
  }
  if (!input.hasAnalysis) {
    return {
      path: 'vacancy',
      pathLabel: 'Есть вакансия',
      headline: 'Вакансия и резюме готовы — сопоставьте их.',
      body: 'Разбор свяжет каждое важное требование с вашим опытом и соберёт вопросы по тем местам, которые стоит укрепить.',
      action: { label: 'Сопоставить с резюме', to: '/prepare' },
      secondaryAction: { label: 'Проверить резюме', to: '/documents' },
      steps,
      currentStep,
    };
  }
  if (!input.practiceCompleted) {
    const started = input.practiceAnswers > 0;
    return {
      path: 'vacancy',
      pathLabel: 'Есть вакансия',
      headline: started ? 'Продолжите с вопроса, на котором остановились.' : 'Проверьте найденные разрывы на практике.',
      body: started
        ? `Пройдено ${input.practiceAnswers} из ${input.practiceQuestions} вопросов. После завершения ответы и оценка останутся в разделе «Практика и интервью».`
        : 'Вопросы уже собраны из требований вакансии и сопоставления с резюме. Ответы покажут реальную отправную точку, а не абстрактный процент.',
      action: {
        label: started ? 'Продолжить практику' : 'Начать практику',
        to: input.activeSessionId ? `/prepare?session=${input.activeSessionId}` : '/prepare',
      },
      secondaryAction: { label: 'Посмотреть резюме', to: '/documents' },
      steps,
      currentStep,
    };
  }
  if (!input.hasApplication) {
    const query = new URLSearchParams();
    if (input.activeVacancyUrl) query.set('vacancyUrl', input.activeVacancyUrl);
    if (input.activeSessionId) query.set('session', input.activeSessionId);
    if (input.activeResumeTitle) query.set('resumeTitle', input.activeResumeTitle);
    const suffix = query.toString();
    return {
      path: 'vacancy',
      pathLabel: 'Есть вакансия',
      headline: 'Подготовка готова — проверьте отклик перед отправкой.',
      body: 'SkillCue перенесёт эту же вакансию и выбранное резюме в раздел откликов. Отправка начнётся только после вашего явного подтверждения.',
      action: { label: 'Проверить и отправить отклик', to: `/applications${suffix ? `?${suffix}` : ''}` },
      secondaryAction: input.activeSessionId
        ? { label: 'Открыть отчёт по вакансии', to: `/prepare?session=${input.activeSessionId}` }
        : undefined,
      steps,
      currentStep: 4,
    };
  }
  if (!input.hasEmployerResponse) {
    return {
      path: 'vacancy',
      pathLabel: 'Есть вакансия',
      headline: 'Отклик отправлен — теперь отслеживайте ответ работодателя.',
      body: 'В разделе откликов видны сообщения HR и вопросы, где требуется ваше решение. Результат подготовки уже сохранён в истории.',
      action: { label: 'Проверить ответы работодателей', to: '/applications?view=dialogs' },
      secondaryAction: input.hasEvidence
        ? { label: 'Посмотреть результаты практики', to: '/history?view=growth' }
        : undefined,
      steps,
      currentStep: 5,
    };
  }
  return {
    path: 'vacancy',
    pathLabel: 'Есть вакансия',
    headline: 'Работодатель ответил — зафиксируйте следующий этап.',
    body: 'Продолжите диалог с HR или добавьте назначенный созвон в календарь. Результаты подготовки остаются в истории отдельно от реальных интервью.',
    action: { label: 'Открыть диалоги с HR', to: '/applications?view=dialogs' },
    secondaryAction: input.activeSessionId
      ? { label: 'Открыть результаты практики', to: '/history?view=growth' }
      : { label: 'Открыть календарь интервью', to: '/calendar' },
    steps,
    currentStep: 5,
  };
}

function profileJourney(input: CandidateJourneySignals): CandidateJourney {
  const done = [
    input.hasResume,
    input.hasGrowthProfile,
    input.hasEvidence,
  ];
  const currentStep = Math.max(0, done.findIndex((value) => !value));
  const stepStatuses = statuses(done);
  const steps: CandidateJourneyStep[] = [
    { id: 'resume', label: 'Резюме', description: 'Факты о текущем опыте', status: stepStatuses[0] },
    { id: 'goal', label: 'Цель', description: 'Направление и стартовая точка', status: stepStatuses[1] },
    { id: 'evidence', label: 'Практика и интервью', description: 'Ответы и результаты', status: stepStatuses[2] },
  ];

  if (!input.hasResume) {
    return {
      path: 'profile',
      pathLabel: 'Вакансии пока нет',
      headline: 'Начните с резюме — это ваша исходная точка.',
      body: 'Резюме даст SkillCue факты о проектах и инструментах. Оно не станет оценкой само по себе: уровень будет подтверждаться только вашими ответами.',
      action: { label: 'Добавить резюме', to: '/documents?mode=baseline' },
      secondaryAction: { label: 'Продолжить без резюме', to: '/documents?mode=baseline&section=goal' },
      steps,
      currentStep,
    };
  }
  if (!input.hasGrowthRole) {
    return {
      path: 'profile',
      pathLabel: 'Вакансии пока нет',
      headline: 'Выберите направление роста.',
      body: 'Цель определит, какие темы важны для подготовки.',
      action: { label: 'Выбрать профессиональную цель', to: '/documents?mode=baseline&section=goal' },
      secondaryAction: { label: 'Проверить резюме', to: '/documents' },
      steps,
      currentStep,
    };
  }
  if (!input.hasGrowthProfile) {
    return {
      path: 'profile',
      pathLabel: 'Вакансии пока нет',
      headline: 'Зафиксируйте стартовую точку.',
      body: 'Короткая самооценка необязательна и хранится отдельно от результатов практики и реальных интервью.',
      action: { label: 'Уточнить цель и стартовую точку', to: '/documents?mode=baseline&section=baseline' },
      steps,
      currentStep,
    };
  }
  if (!input.hasEvidence) {
    return {
      path: 'profile',
      pathLabel: 'Вакансии пока нет',
      headline: 'Подтвердите навыки на практике.',
      body: 'Выберите вакансию или разберите реальное интервью.',
      action: { label: 'Найти вакансии на HH', to: '/applications?mode=settings' },
      secondaryAction: { label: 'Добавить вакансию вручную', to: '/prepare' },
      steps,
      currentStep,
    };
  }
  return {
    path: 'profile',
    pathLabel: 'Вакансии пока нет',
    headline: 'Результаты практики сохранены — сравните попытки и выберите следующую тему.',
    body: 'В истории практика отделена от реальных интервью, а изменение балла показывается только для сопоставимых попыток по одной роли.',
    action: { label: 'Посмотреть результаты практики', to: '/history?view=growth' },
    secondaryAction: { label: 'Разобрать новую вакансию', to: '/prepare' },
    steps,
    currentStep: 2,
  };
}

export function inferCandidatePath(input: CandidateJourneySignals): CandidatePath | null {
  if (input.selectedPath) return input.selectedPath;
  if (input.hasVacancy || input.hasAnalysis || input.practiceAnswers > 0 || input.practiceCompleted) return 'vacancy';
  if (input.hasResume || input.hasGrowthRole || input.hasGrowthProfile || input.hasEvidence) return 'profile';
  return null;
}

export function buildCandidateJourney(input: CandidateJourneySignals): CandidateJourney {
  const path = inferCandidatePath(input);
  if (path === 'vacancy') return vacancyJourney(input);
  if (path === 'profile') return profileJourney(input);
  return {
    path: null,
    pathLabel: 'Выберите отправную точку',
    headline: 'С чего вы начинаете сегодня?',
    body: 'Путь зависит от того, есть ли уже конкретная вакансия. В обоих вариантах SkillCue свяжет исходные данные, практику, отклики и результаты интервью.',
    action: { label: 'Добавить вакансию', to: '/prepare' },
    secondaryAction: { label: 'Начать без вакансии', to: '/documents?mode=baseline' },
    steps: [],
    currentStep: 0,
  };
}

export function readCandidatePath(): CandidatePath | null {
  try {
    const stored = localStorage.getItem(CANDIDATE_PATH_STORAGE_KEY);
    return stored === 'vacancy' || stored === 'profile' ? stored : null;
  } catch {
    return null;
  }
}

export function saveCandidatePath(path: CandidatePath): void {
  try {
    localStorage.setItem(CANDIDATE_PATH_STORAGE_KEY, path);
  } catch {
    // The journey still works for the current session when storage is unavailable.
  }
}

export function readStoredGrowthProfile(): StoredGrowthProfile {
  try {
    const value = JSON.parse(localStorage.getItem(GROWTH_PROFILE_STORAGE_KEY) || '') as StoredGrowthProfile;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
import { GROWTH_PROFILE_STORAGE_KEY } from './growthProfile';
