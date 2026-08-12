import { describe, expect, it } from 'vitest';
import {
  answerExperienceThresholdFromResume,
  buildSalaryExpectationAnswer,
  findResumeExperienceMonths,
  findSalaryExpectation,
  knownScreeningAnswer,
  localScreeningDraft,
  reusableScreeningAnswer,
  screeningQuestionSemanticKey,
  screeningRelocationScope,
  selectRelevantScreeningFacts,
} from './hhScreeningKnowledge';

describe('HH candidate screening knowledge', () => {
  it('answers an experience threshold from the total shown in the selected resume', () => {
    const resume = 'Опыт работы: 4 года 2 месяца\nВедущий инженер по автоматизации тестирования';
    expect(findResumeExperienceMonths(resume)).toBe(50);
    expect(answerExperienceThresholdFromResume('Ваш опыт в автотестировании более 1 года?', resume)).toBe('Да');
    expect(answerExperienceThresholdFromResume('Ваш опыт в автотестировании более 5 лет?', resume)).toBe('Нет');
  });

  it('builds the same salary wording for a recruiter chat', () => {
    expect(buildSalaryExpectationAnswer(240_000, 'Какой минимум и комфорт по зарплате?'))
      .toBe('Минимум — 240 000 ₽ на руки; комфортный уровень готов обсудить с учётом задач и общего компенсационного пакета.');
  });

  it('uses the explicit salary preference before résumé text', () => {
    expect(findSalaryExpectation(250_000, ['QA Automation 220 000 ₽'])).toBe(250_000);
  });

  it('reads a salary printed in the selected HH résumé title', () => {
    expect(findSalaryExpectation(null, ['QA Automation Engineer 220 000 ₽ · Удалённо'])).toBe(220_000);
  });

  it('answers a salary range without asking the user again', () => {
    const result = knownScreeningAnswer({
      id: 'salary',
      prompt: 'Какую зп вилку рассматриваете? (минимум-комфорт)',
      kind: 'text',
      options: [],
      required: true,
    }, 220_000);
    expect(result?.canAutoFill).toBe(true);
    expect(result?.answer).toContain('220\u00a0000 ₽');
    expect(result?.answer).toContain('Минимум');
  });

  it('does not manufacture unknown Matrix experience', () => {
    expect(knownScreeningAnswer({
      id: 'matrix',
      prompt: 'Был ли у вас опыт с Matrix? Какие задачи выполняли?',
      kind: 'text',
      options: [],
      required: true,
    }, 220_000)).toBeNull();
  });

  it('answers a general QA test even when the remote model is unavailable', () => {
    const result = knownScreeningAnswer({
      id: 'smoke',
      prompt: 'После изменений в критическом модуле нужно быстро удостовериться, что он не упал. Что выберете?',
      kind: 'single',
      options: [
        'Выполнить smoke-тестирование основного сценария использования модуля',
        'Запустить полный регресс по всему связанному функционалу',
      ],
      required: true,
    }, null);
    expect(result?.selectedOptions).toEqual([
      'Выполнить smoke-тестирование основного сценария использования модуля',
    ]);
    expect(result?.canAutoFill).toBe(true);
  });

  it('writes the requested Python function and tests locally', () => {
    const result = knownScreeningAnswer({
      id: 'code',
      prompt: 'Реализуйте compress_numbers: удалите подряд идущие дубликаты и напишите автотесты.',
      kind: 'text',
      options: [],
      required: true,
    }, null);
    expect(result?.answer).toContain('def compress_numbers(numbers):');
    expect(result?.answer).toContain('def test_compress_numbers():');
    expect(result?.canAutoFill).toBe(true);
  });

  it('still asks the user about personal game history', () => {
    expect(knownScreeningAnswer({
      id: 'games',
      prompt: 'В какие мобильные игры вы играли за последние 3 месяца?',
      kind: 'text',
      options: [],
      required: true,
    }, null)).toBeNull();
  });

  it('offers an editable RTS hypothesis without marking it safe for auto-fill', () => {
    const result = localScreeningDraft({
      id: 'rts-games',
      prompt: 'Нравятся ли вам игры жанра RTS? В какие игры этого жанра вы играли?',
      kind: 'text',
      options: [],
      required: true,
    });
    expect(result?.answer).toContain('StarCraft II');
    expect(result?.answer).toContain('Age of Empires II');
    expect(result?.canAutoFill).toBe(false);
    expect(result?.reason).toContain('предположение');
  });

  it('does not locally guess high-risk location facts', () => {
    expect(localScreeningDraft({
      id: 'location',
      prompt: 'В какой локации вы проживаете?',
      kind: 'text',
      options: [],
      required: true,
    })).toBeNull();
  });

  it('offers a conditional relocation draft without auto-submitting consent', () => {
    const result = localScreeningDraft({
      id: 'relocation',
      prompt: 'Готовы ли Вы к релокации в Саудовскую Аравию на 3 месяца (релокацию оплачиваем)?',
      kind: 'text',
      options: [],
      required: true,
    });
    expect(result?.answer).toContain('Саудовскую Аравию');
    expect(result?.answer).toContain('три месяца');
    expect(result?.answer).toContain('если работодатель оплачивает');
    expect(result?.canAutoFill).toBe(false);
  });

  it('groups Russian relocation without broadening it to international relocation', () => {
    const ryazan = 'Готовы ли вы к переезду в г. Рязань для офисного формата?';
    const yoshkar = 'Готовы ли вы к переезду в Йошкар-Олу?';
    const saudi = 'Готовы ли вы к релокации в Саудовскую Аравию?';
    expect(screeningRelocationScope(ryazan)).toBe('russia');
    expect(screeningRelocationScope(yoshkar)).toBe('russia');
    expect(screeningRelocationScope(saudi)).toBe('abroad');
    expect(screeningQuestionSemanticKey(ryazan)).toBe(screeningQuestionSemanticKey(yoshkar));
    expect(screeningQuestionSemanticKey(ryazan)).not.toBe(screeningQuestionSemanticKey(saudi));
  });

  it('does not treat an unknown destination as Russia', () => {
    const unknown = 'Готовы ли вы к переезду в Пуэрто-Вальярту?';
    expect(screeningRelocationScope(unknown)).toBe('unspecified');
    expect(screeningQuestionSemanticKey(unknown)).not.toBe('preference:relocation:russia');
  });

  it('maps one confirmed Russian relocation refusal to differently worded options', () => {
    const answer = reusableScreeningAnswer({
      id: 'yoshkar',
      prompt: 'Готовы ли вы к переезду в Йошкар-Олу?',
      kind: 'single',
      options: ['Да, готов(а)', 'Скорее да, хотелось бы узнать условия', 'Нет, рассматриваю только работу в своем городе'],
      required: true,
    }, {
      question: 'Готовы ли вы к переезду в г. Рязань?',
      answer: '',
      selectedOptions: ['Нет, рассматриваю только удалённый формат'],
    });
    expect(answer?.canAutoFill).toBe(true);
    expect(answer?.selectedOptions).toEqual(['Нет, рассматриваю только работу в своем городе']);
  });

  it('uses the remote-only filter for Russian relocation but still asks about abroad', () => {
    const russian = knownScreeningAnswer({
      id: 'ryazan', prompt: 'Готовы ли вы к переезду в Рязань?', kind: 'single',
      options: ['Да, готов переехать', 'Нет, только удалённый формат'], required: true,
    }, null, '', { remoteOnly: true });
    const abroad = knownScreeningAnswer({
      id: 'saudi', prompt: 'Готовы ли вы к релокации в Саудовскую Аравию?', kind: 'single',
      options: ['Да', 'Нет'], required: true,
    }, null, '', { remoteOnly: true });
    expect(russian?.selectedOptions).toEqual(['Нет, только удалённый формат']);
    expect(abroad).toBeNull();
  });

  it('answers a fintech question from the selected résumé without inventing web3 work', () => {
    const result = knownScreeningAnswer({
      id: 'fintech',
      prompt: 'Имеется ли у вас опыт работы в финтехе/веб3 сферах?',
      kind: 'text',
      options: [],
      required: true,
    }, null, 'AQA-Engineer Python — Сбербанк. Автоматизировал UI и API тестирование.');
    expect(result?.canAutoFill).toBe(true);
    expect(result?.answer).toContain('Сбербанка');
    expect(result?.answer).toContain('Коммерческого опыта в web3 нет');
  });

  it('answers confirmed web and commercial automation experience without remote AI', () => {
    const resume = `Опыт работы: 4 года 2 месяца
• ГЕОМИКС2 года и 2 месяца
Ведущий инженер по автоматизации тестирования
Тестировал web-приложения. Разрабатывал UI автотесты на Python + Pytest + Playwright.
• Сбер1 год
AQA-Engineer Python. API автотесты Requests + Pytest.
• ООО ЦПР1 год и 3 месяца
Разрабатывал UI-автотесты на Python + Selenium.`;

    const web = knownScreeningAnswer({
      id: 'web', prompt: 'У Вас есть опыт тестирования WEB-приложений?', kind: 'text', options: [], required: false,
    }, null, resume);
    const automation = knownScreeningAnswer({
      id: 'automation', prompt: 'У Вас есть коммерческий опыт написания автотестов? С какими инструментами и в какой компании?', kind: 'text', options: [], required: false,
    }, null, resume);

    expect(web?.canAutoFill).toBe(true);
    expect(web?.answer).toContain('4 года 2 месяца');
    expect(automation?.canAutoFill).toBe(true);
    expect(automation?.answer).toContain('ГЕОМИКС');
    expect(automation?.answer).toContain('Сбер');
    expect(automation?.answer).toContain('Python, Pytest, Playwright, Selenium, Requests');
  });

  it('selects yes for confirmed commercial Python automation experience', () => {
    const resume = [
      'Опыт работы: 4 года 2 месяца',
      '• ГЕОМИКС2 года и 2 месяца',
      'Разрабатывал автотесты на Python, Pytest и Playwright.',
    ].join('\n');

    const answer = knownScreeningAnswer({
      id: 'commercial-python',
      prompt: 'Есть ли практический (коммерческий) опыт с автотестированием на python?',
      kind: 'multiple',
      options: ['Да', 'Нет'],
      required: false,
    }, null, resume);

    expect(answer).toMatchObject({
      selectedOptions: ['Да'],
      canAutoFill: true,
    });
  });

  it('answers a typo-tolerant AI usage question locally', () => {
    const answer = knownScreeningAnswer({
      id: 'ai', prompt: 'Вы используете в работе ИИ? Какие заджачи Вы решаете при помощи ИИ?', kind: 'text', options: [], required: false,
    }, null, '');
    expect(answer?.canAutoFill).toBe(true);
    expect(answer?.answer).toContain('анализа требований');
  });

  it('keeps an older Matrix fact ahead of newer unrelated facts', () => {
    const matrix = {
      question: 'Был ли опыт с Matrix или другими мессенджерами?',
      answer: 'Использовал Matrix в личном self-hosted стенде.',
      selectedOptions: [],
    };
    const facts = [
      matrix,
      ...Array.from({ length: 35 }, (_, index) => ({
        question: `Готовы ли вы к командировке ${index}?`,
        answer: 'Нет',
        selectedOptions: [],
      })),
    ];
    const selected = selectRelevantScreeningFacts(facts, [{
      id: 'matrix-new',
      prompt: 'Работали ли вы с Matrix? Опишите задачи.',
      kind: 'text',
      options: [],
      required: true,
    }], 30);
    expect(selected[0]).toBe(matrix);
    expect(selected).toContain(matrix);
  });
});
