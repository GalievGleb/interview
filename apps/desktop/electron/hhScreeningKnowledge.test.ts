import { describe, expect, it } from 'vitest';
import {
  answerExperienceThresholdFromResume,
  buildSalaryExpectationAnswer,
  findResumeLocation,
  findResumeExperienceMonths,
  findSalaryExpectation,
  isSalaryExpectationQuestion,
  isSalaryRelatedQuestion,
  knownScreeningAnswer,
  localScreeningDraft,
  reusableScreeningAnswer,
  screeningQuestionSemanticKey,
  screeningRelocationScope,
  selectRelevantScreeningFacts,
} from './hhScreeningKnowledge';

describe('HH candidate screening knowledge', () => {
  it('answers only a total-career threshold from the total shown in the selected resume', () => {
    const resume = 'Опыт работы: 4 года 2 месяца\nВедущий инженер по автоматизации тестирования';
    expect(findResumeExperienceMonths(resume)).toBe(50);
    expect(answerExperienceThresholdFromResume('Ваш общий опыт работы более 1 года?', resume)).toBe('Да');
    expect(answerExperienceThresholdFromResume('Ваш общий опыт работы более 5 лет?', resume)).toBe('Нет');
    expect(answerExperienceThresholdFromResume(
      'Ваш опыт в автотестировании от 1 года?',
      `QA Automation Engineer Python\n${resume}\npytest, Playwright, автотесты`,
    )).toBe('Да');
    expect(answerExperienceThresholdFromResume(
      'Ваш опыт в автотестировании более 3 лет?',
      `QA Automation Engineer Python\n${resume}\npytest, Playwright, автотесты`,
    )).toBeNull();
  });

  it('selects the grounded language option for a one-year automation threshold', () => {
    expect(knownScreeningAnswer({
      id: 'automation-year',
      prompt: 'Есть ли у вас опыт в авто тестировании (от 1 года)?',
      kind: 'single',
      options: ['Да, на C#.', 'Да, на Java.', 'Да, на Python.', 'Нет.'],
      required: false,
    }, null, 'QA Fullstack Engineer Python · pytest · Playwright')).toMatchObject({
      selectedOptions: ['Да, на Python.'],
      canAutoFill: true,
      sourceType: 'resume',
    });
  });

  it('builds the same salary wording for a recruiter chat', () => {
    expect(buildSalaryExpectationAnswer(240_000, 'Какой минимум и комфорт по зарплате?'))
      .toBe('Минимум — 240 000 ₽ в месяц; комфортный уровень готов обсудить с учётом задач и общего компенсационного пакета.');
  });

  it('keeps a net salary qualifier only when the same amount explicitly has it', () => {
    expect(buildSalaryExpectationAnswer(
      240_000,
      'Какой минимум и комфорт по зарплате?',
      'QA Automation Engineer · 240 000 ₽ на руки · удалённо',
    )).toContain('240 000 ₽ на руки');
    expect(buildSalaryExpectationAnswer(
      240_000,
      'Какой минимум и комфорт по зарплате?',
      'QA Automation Engineer · 220 000 ₽ на руки · удалённо',
    )).toContain('240 000 ₽ в месяц');
  });

  it('requires an explicit tax basis in the question to match the exact salary source', () => {
    expect(buildSalaryExpectationAnswer(
      240_000,
      'Какую зарплату на руки вы ожидаете?',
      'Желаемая зарплата: 240 000 ₽ на руки',
    )).toContain('240 000 ₽ на руки');
    expect(buildSalaryExpectationAnswer(
      240_000,
      'Какую зарплату gross вы ожидаете?',
      'Желаемая зарплата: 240 000 ₽ gross',
    )).toContain('240 000 ₽ до вычета налогов');
    expect(buildSalaryExpectationAnswer(
      240_000,
      'Какую зарплату gross вы ожидаете?',
      'Желаемая зарплата: 240 000 ₽ на руки',
    )).toBe('');
    expect(buildSalaryExpectationAnswer(
      240_000,
      'Какую зарплату на руки вы ожидаете?',
      'QA Automation Engineer · 240 000 ₽ · удалённо',
    )).toBe('');
    expect(knownScreeningAnswer({
      id: 'salary-tax-basis',
      prompt: 'Какую зарплату до налогов вы ожидаете?',
      kind: 'text',
      options: [],
      required: true,
    }, 240_000, 'Желаемая зарплата: 240 000 ₽ на руки')).toBeNull();
    expect(knownScreeningAnswer({
      id: 'salary-net-without-source-basis',
      prompt: 'Желаемая сумма на руки?',
      kind: 'text',
      options: [],
      required: true,
    }, 240_000)).toBeNull();
    expect(buildSalaryExpectationAnswer(
      240_000,
      'Какую зарплату gross вы ожидаете?',
      'Желаемая зарплата: 240 000 ₽ грязными',
    )).toContain('240 000 ₽ до вычета налогов');
    for (const ambiguousTaxPrompt of [
      'Какую зарплату ожидаете после вычета 13%?',
      'Какую зарплату ожидаете без учёта налогов?',
      'Какую зарплату ожидаете с налогами?',
    ]) {
      expect(buildSalaryExpectationAnswer(
        240_000,
        ambiguousTaxPrompt,
        'Желаемая зарплата: 240 000 ₽',
      )).toBe('');
    }
  });

  it('uses the exact selected résumé salary before the HH search floor', () => {
    expect(findSalaryExpectation(200_000, ['QA Automation 220 000 ₽'])).toBe(220_000);
    expect(findSalaryExpectation(200_000, ['QA Automation без указанной зарплаты'])).toBe(200_000);
  });

  it('reads a salary printed in the selected HH résumé title', () => {
    expect(findSalaryExpectation(null, ['QA Automation Engineer 220 000 ₽ · Удалённо'])).toBe(220_000);
  });

  it('does not interpret an explicitly non-monthly résumé amount as monthly salary', () => {
    expect(findSalaryExpectation(null, ['Желаемая зарплата: 220 000 ₽ в год'])).toBeNull();
    expect(findSalaryExpectation(null, ['Expected salary: 220 000 RUB per hour'])).toBeNull();
    expect(findSalaryExpectation(null, ['Желаемая зарплата: 220 000 ₽ в месяц'])).toBe(220_000);
  });

  it('does not mistake historical pay or a project budget for salary expectations', () => {
    expect(findSalaryExpectation(null, [
      'QA Automation Engineer\nПолучал 180 000 ₽ на предыдущем месте\nУправлял бюджетом 500 000 ₽',
    ])).toBeNull();
    expect(findSalaryExpectation(null, [
      'QA Automation Engineer\nЖелаемая зарплата: 220 000 ₽\nПолучал 180 000 ₽',
    ])).toBe(220_000);
    expect(findSalaryExpectation(null, [
      'QA Automation Engineer\nОжидаемый бюджет проекта — 500 000 ₽',
    ])).toBeNull();
    expect(findSalaryExpectation(null, [
      'Ожидаемый бюджет проекта — 500 000 ₽',
    ])).toBeNull();
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
    expect(result?.answer).not.toContain('на руки');
  });

  it('reads the current city from the selected HH resume', () => {
    const resume = 'Город проживания: Казань\n\nQA Automation Engineer\nPython · pytest';
    expect(findResumeLocation(resume)).toBe('Казань');
    const answer = knownScreeningAnswer({
      id: 'current-city',
      prompt: 'Где вы сейчас живёте?',
      kind: 'text',
      options: [],
      required: true,
    }, null, resume);
    expect(answer).toMatchObject({
      answer: 'Казань',
      canAutoFill: true,
      sourceType: 'resume',
    });
  });

  it.each([
    'Где живёте?',
    'Где живешь?',
    'Где проживаете?',
    'Укажите населённый пункт',
  ])('recognizes a concise current-city question: %s', (prompt) => {
    expect(screeningQuestionSemanticKey(prompt)).toBe('profile:current-location');
    expect(knownScreeningAnswer({
      id: 'current-city-short',
      prompt,
      kind: 'text',
      options: [],
      required: true,
    }, null, 'Город проживания: Казань')).toMatchObject({
      answer: 'Казань',
      canAutoFill: true,
      sourceType: 'resume',
    });
  });

  it('reuses one confirmed current-city fact across employer wording', () => {
    const savedQuestion = 'В каком городе проживаешь фактически?';
    const nextQuestion = 'Укажите город вашего текущего проживания';
    expect(screeningQuestionSemanticKey(savedQuestion)).toBe(screeningQuestionSemanticKey(nextQuestion));
    expect(reusableScreeningAnswer({
      id: 'city-next',
      prompt: nextQuestion,
      kind: 'text',
      options: [],
      required: true,
    }, {
      question: savedQuestion,
      answer: 'Казань',
      selectedOptions: [],
    })).toMatchObject({ answer: 'Казань', canAutoFill: true });
  });

  it('does not confuse project location restrictions with the candidate city', () => {
    const restriction = 'На проектах есть ограничения по месту нахождения кандидата (РФ/вне РФ). Готовы ли вы рассматривать такие проекты?';
    expect(screeningQuestionSemanticKey(restriction)).not.toBe(
      screeningQuestionSemanticKey('В каком городе вы сейчас проживаете?'),
    );
    expect(screeningQuestionSemanticKey('В каком городе находится офис работодателя?'))
      .not.toBe(screeningQuestionSemanticKey('В какой локации вы проживаете?'));
  });

  it.each([
    'Укажите ваши финансовые ожидания',
    'Какую заработную плату ожидаете?',
    'Какой доход вы ожидаете?',
    'Какую зарплату вы хотите?',
    'Сколько хотите получать?',
    'Сколько вы хотите зарабатывать?',
    'На какую сумму рассчитываете?',
    'От какой суммы готовы рассматривать предложения?',
    'Какая сумма вас устроит?',
    'Какую оплату ожидаете?',
    'Какую зарплату в рублях в месяц ожидаете?',
    'What is your expected salary level?',
    'What are your financial expectations?',
  ])('recognizes salary wording: %s', (prompt) => {
    const result = knownScreeningAnswer({
      id: 'salary-wording', prompt, kind: 'text', options: [], required: true,
    }, 220_000);
    expect(result?.canAutoFill).toBe(true);
    expect(result?.answer).toContain('220\u00a0000 ₽');
  });

  it.each([
    'Какую зарплату вы получали на последнем месте?',
    'Какой у вас текущий доход?',
    'Сколько вы получаете сейчас?',
    'Какую сумму вы получали на последнем месте?',
    'What was your previous salary?',
  ])('does not substitute expectations for salary history: %s', (prompt) => {
    expect(knownScreeningAnswer({
      id: 'salary-history', prompt, kind: 'text', options: [], required: true,
    }, 220_000)).toBeNull();
  });

  it.each([
    'Какую зарплату ожидаете в час?',
    'Какую зарплату ожидаете за день?',
    'Какую зарплату ожидаете за смену?',
    'Какую зарплату ожидаете за неделю?',
    'Какую зарплату ожидаете за год?',
    'Какую зарплату ожидаете в квартал?',
    'Какую зарплату ожидаете ежеквартально?',
    'Какую зарплату ожидаете за весь проект?',
    'Какую зарплату ожидаете за контракт?',
    'Какую зарплату ожидаете за 3 месяца?',
    'Какую зарплату ожидаете за две недели?',
    'Какую зарплату ожидаете за три месяца?',
    'What annual salary do you expect?',
  ])('does not answer a non-monthly salary request: %s', (prompt) => {
    expect(isSalaryExpectationQuestion(prompt)).toBe(false);
    expect(knownScreeningAnswer({
      id: 'salary-cadence', prompt, kind: 'text', options: [], required: true,
    }, 220_000, 'Желаемая зарплата: 220 000 ₽ в месяц')).toBeNull();
  });

  it.each([
    'Какую зарплату в USD вы ожидаете?',
    'Какую зарплату в долларах вы ожидаете?',
    'Какую зарплату в евро вы ожидаете?',
    'Какую зарплату в тенге вы ожидаете?',
    'Какую зарплату в BYN вы ожидаете?',
    'Какую зарплату в белорусских рублях вы ожидаете?',
    'Какую зарплату в GEL вы ожидаете?',
    'Какую зарплату в лари вы ожидаете?',
    'Какую зарплату в AMD вы ожидаете?',
    'Какую зарплату в драмах вы ожидаете?',
    'Какую зарплату в UZS вы ожидаете?',
    'Какую зарплату в USDT вы ожидаете?',
    'Какую зарплату в cad вы ожидаете?',
    'Какую зарплату в chf вы ожидаете?',
    'Какую зарплату в try вы ожидаете?',
    'Какую зарплату в inr вы ожидаете?',
    'What salary in usd do you expect?',
    'Какую зарплату в eUr вы ожидаете?',
    'Какую зарплату в сомах вы ожидаете?',
    'Какую зарплату в фунтах вы ожидаете?',
    'Какую зарплату в иенах вы ожидаете?',
  ])('does not convert an explicit non-RUB salary request: %s', (prompt) => {
    expect(isSalaryExpectationQuestion(prompt)).toBe(false);
    expect(knownScreeningAnswer({
      id: 'salary-currency', prompt, kind: 'text', options: [], required: true,
    }, 220_000, 'Желаемая зарплата: 220 000 ₽ в месяц')).toBeNull();
  });

  it.each([
    'На какую сумму рассчитываете?',
    'Какую оплату ожидаете?',
    'Какой ваш рейт?',
    'Какая у вас ставка?',
    'Какой гонорар рассматриваете?',
    'Сколько хотите получать?',
    'Сколько вы хотите зарабатывать?',
  ])('classifies compensation wording for provenance: %s', (prompt) => {
    expect(isSalaryRelatedQuestion(prompt)).toBe(true);
  });

  it.each([
    'Какой ваш рейт?',
    'Какая у вас ставка?',
    'Какой гонорар рассматриваете?',
  ])('does not auto-answer an ambiguous compensation unit: %s', (prompt) => {
    expect(isSalaryExpectationQuestion(prompt)).toBe(false);
    expect(knownScreeningAnswer({
      id: 'salary-related-ambiguous', prompt, kind: 'text', options: [], required: true,
    }, 220_000, 'Желаемая зарплата: 220 000 ₽ в месяц')).toBeNull();
  });

  it.each([
    'Какие уведомления хотите получать?',
    'Какую сумму инвестиций хотите привлечь?',
  ])('does not confuse another desired value with salary: %s', (prompt) => {
    expect(isSalaryExpectationQuestion(prompt)).toBe(false);
  });

  it.each([
    'Укажите ваш город рождения',
    'Укажите город регистрации',
    'Укажите город прописки',
    'Укажите город, где находится офис работодателя',
    'В каком городе работает команда проекта?',
    'Укажите город, в котором хотели бы работать',
    'Укажите город получения образования',
    'Укажите любимый город',
    'Назовите любой город',
    'В каком регионе вы сейчас проживаете?',
    'В каком субъекте РФ вы сейчас проживаете?',
    'Укажите область проживания',
  ])('does not treat another place as current residence: %s', (prompt) => {
    expect(screeningQuestionSemanticKey(prompt)).not.toBe('profile:current-location');
    expect(knownScreeningAnswer({
      id: 'other-location', prompt, kind: 'text', options: [], required: true,
    }, null, 'Город проживания: Москва')).toBeNull();
  });

  it('does not map a current city to a negated option', () => {
    const answer = knownScreeningAnswer({
      id: 'city-choice',
      prompt: 'Ваш текущий город?',
      kind: 'single',
      options: ['Не Москва', 'г. Москва', 'Санкт-Петербург'],
      required: true,
    }, null, 'Город проживания: Москва');
    expect(answer?.selectedOptions).toEqual(['г. Москва']);
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

  it('does not guess whether recent work was official under Russian labor law', () => {
    const question = {
      id: 'official-work',
      prompt: 'Твой опыт работы за последние 3 года — официальный (по ТК РФ)?',
      kind: 'single' as const,
      options: ['Да', 'Нет'],
      required: true,
    };
    expect(localScreeningDraft(question)).toBeNull();
  });

  it('does not invent named RTS games when personal history is unknown', () => {
    const result = localScreeningDraft({
      id: 'rts-games',
      prompt: 'Нравятся ли вам игры жанра RTS? В какие игры этого жанра вы играли?',
      kind: 'text',
      options: [],
      required: true,
    });
    expect(result).toBeNull();
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

  it('does not invent consent to relocation', () => {
    const result = localScreeningDraft({
      id: 'relocation',
      prompt: 'Готовы ли Вы к релокации в Саудовскую Аравию на 3 месяца (релокацию оплачиваем)?',
      kind: 'text',
      options: [],
      required: true,
    });
    expect(result).toBeNull();
  });

  it.each([
    ['single', 'Работали ли вы со Swift?', ['Да', 'Нет']],
    ['select', 'Есть ли коммерческий опыт с 1С?', ['Да', 'Нет']],
  ] as const)('does not guess an affirmative %s experience option', (kind, prompt, options) => {
    expect(localScreeningDraft({
      id: `unknown-${kind}`,
      prompt,
      kind,
      options: [...options],
      required: true,
    })).toBeNull();
  });

  it.each([
    'Расскажите про ваш опыт со Swift',
    'Опишите опыт автоматизации тестирования 1С',
    'Какими мобильными играми вы пользовались за последние три месяца?',
  ])('does not manufacture personal history for: %s', (prompt) => {
    expect(localScreeningDraft({
      id: 'unknown-history',
      prompt,
      kind: 'text',
      options: [],
      required: true,
    })).toBeNull();
  });

  it('classifies relocation scope without collapsing different destinations', () => {
    const ryazan = 'Готовы ли вы к переезду в г. Рязань для офисного формата?';
    const yoshkar = 'Готовы ли вы к переезду в Йошкар-Олу?';
    const saudi = 'Готовы ли вы к релокации в Саудовскую Аравию?';
    expect(screeningRelocationScope(ryazan)).toBe('russia');
    expect(screeningRelocationScope(yoshkar)).toBe('russia');
    expect(screeningRelocationScope(saudi)).toBe('abroad');
    expect(screeningQuestionSemanticKey(ryazan)).not.toBe(screeningQuestionSemanticKey(yoshkar));
    expect(screeningQuestionSemanticKey(ryazan)).not.toBe(screeningQuestionSemanticKey(saudi));
  });

  it('does not treat an unknown destination as Russia', () => {
    const unknown = 'Готовы ли вы к переезду в Пуэрто-Вальярту?';
    expect(screeningRelocationScope(unknown)).toBe('unspecified');
    expect(screeningQuestionSemanticKey(unknown)).not.toBe('preference:relocation:russia');
  });

  it('maps an explicit global remote-only refusal to differently worded options', () => {
    const answer = reusableScreeningAnswer({
      id: 'yoshkar',
      prompt: 'Готовы ли вы к переезду в Йошкар-Олу?',
      kind: 'single',
      options: ['Да, готов(а)', 'Скорее да, хотелось бы узнать условия', 'Нет, только удалённый формат'],
      required: true,
    }, {
      question: 'Готовы ли вы к переезду в г. Рязань?',
      answer: '',
      selectedOptions: ['Нет, рассматриваю только удалённый формат'],
    });
    expect(answer?.canAutoFill).toBe(true);
    expect(answer?.selectedOptions).toEqual(['Нет, только удалённый формат']);
  });

  it('does not reuse a city-specific refusal for another destination', () => {
    expect(screeningQuestionSemanticKey('Готовы ли вы к переезду в Рязань?'))
      .not.toBe(screeningQuestionSemanticKey('Готовы ли вы к переезду в Йошкар-Олу?'));
    expect(reusableScreeningAnswer({
      id: 'yoshkar-specific',
      prompt: 'Готовы ли вы к переезду в Йошкар-Олу?',
      kind: 'single',
      options: ['Да', 'Нет'],
      required: true,
    }, {
      question: 'Готовы ли вы к переезду в Рязань?',
      answer: 'Нет, в Рязань переезжать не готов.',
      selectedOptions: ['Нет'],
    })).toBeNull();
  });

  it('does not turn remote-only into a commitment to visit an office', () => {
    expect(reusableScreeningAnswer({
      id: 'remote-office',
      prompt: 'Готовы ли вы к переезду в Рязань?',
      kind: 'single',
      options: ['Да', 'Нет, но готов регулярно приезжать в офис'],
      required: true,
    }, {
      question: 'Рассматриваете ли вы переезд по России ради работы?',
      answer: 'Нет, переезды по России не рассматриваю. Интересует только удалённая работа.',
      selectedOptions: [],
    })).toBeNull();
  });

  it('does not reuse relocation consent for a different Russian destination', () => {
    const answer = reusableScreeningAnswer({
      id: 'yoshkar',
      prompt: 'Готовы ли вы к переезду в Йошкар-Олу?',
      kind: 'single',
      options: ['Да, готов(а)', 'Нет'],
      required: true,
    }, {
      question: 'Готовы ли вы к переезду в Рязань?',
      answer: '',
      selectedOptions: ['Да, готов(а)'],
    });
    expect(answer).toBeNull();
  });

  it('reuses an explicitly confirmed global refusal for Russia but not for relocation abroad', () => {
    const fact = {
      question: 'Рассматриваете ли вы переезд по России ради работы?',
      answer: 'Нет, переезды по России не рассматриваю. Интересует только удалённая работа.',
      selectedOptions: [] as string[],
    };
    const russian = reusableScreeningAnswer({
      id: 'ryazan', prompt: 'Готовы ли вы к переезду в Рязань?', kind: 'single',
      options: ['Да, готов переехать', 'Нет, только удалённый формат'], required: true,
    }, fact);
    const abroad = reusableScreeningAnswer({
      id: 'saudi', prompt: 'Готовы ли вы к релокации в Саудовскую Аравию?', kind: 'single',
      options: ['Да', 'Нет'], required: true,
    }, fact);
    expect(russian?.selectedOptions).toEqual(['Нет, только удалённый формат']);
    expect(abroad).toBeNull();
  });

  it('keeps fintech history in review mode even when the résumé mentions a bank', () => {
    const result = knownScreeningAnswer({
      id: 'fintech',
      prompt: 'Имеется ли у вас опыт работы в финтехе/веб3 сферах?',
      kind: 'text',
      options: [],
      required: true,
    }, null, 'AQA-Engineer Python — Сбербанк. Автоматизировал UI и API тестирование.');
    expect(result).toBeNull();
  });

  it('does not turn a sparse bank mention into Sber AQA experience', () => {
    const result = knownScreeningAnswer({
      id: 'fintech-sparse',
      prompt: 'Имеется ли у вас опыт работы в финтехе/веб3 сферах?',
      kind: 'text', options: [], required: true,
    }, null, 'Работал аналитиком в другом банке.');

    expect(result).toBeNull();
  });

  it('keeps free-form web experience in review mode', () => {
    const result = knownScreeningAnswer({
      id: 'web-basic', prompt: 'У Вас есть опыт тестирования WEB-приложений?',
      kind: 'text', options: [], required: false,
    }, null, 'Опыт работы: 4 года. Тестировал web-приложения вручную.');

    expect(result).toBeNull();
  });

  it('does not reverse an explicit negative résumé statement', () => {
    expect(knownScreeningAnswer({
      id: 'web-negative', prompt: 'У Вас есть опыт тестирования WEB-приложений?',
      kind: 'text', options: [], required: false,
    }, null, 'Не тестировал web-приложения.')).toBeNull();

    expect(knownScreeningAnswer({
      id: 'web-negative-suffix', prompt: 'У Вас есть опыт тестирования WEB-приложений?',
      kind: 'text', options: [], required: false,
    }, null, 'Тестирование web-приложений не выполнял.')).toBeNull();
  });

  it('does not select yes for option questions backed only by negative résumé statements', () => {
    expect(knownScreeningAnswer({
      id: 'web-negative-option', prompt: 'У Вас есть опыт тестирования WEB-приложений?',
      kind: 'single', options: ['Да', 'Нет'], required: false,
    }, null, 'Не тестировал web-приложения.')).toBeNull();

    expect(knownScreeningAnswer({
      id: 'automation-negative-option',
      prompt: 'Есть ли практический (коммерческий) опыт с автотестированием на python?',
      kind: 'multiple', options: ['Да', 'Нет'], required: false,
    }, null, 'ООО Пример. Автотесты на Python не разрабатывал.')).toBeNull();
  });

  it('keeps compound personal experience answers in review mode', () => {
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

    expect(web).toBeNull();
    expect(automation).toBeNull();
  });

  it('does not preselect yes for commercial Python experience', () => {
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

    expect(answer).toBeNull();
  });

  it('does not combine an employer elsewhere with a personal Python test project', () => {
    const resume = [
      'Опыт работы: 2 года',
      '• ООО Пример2 года',
      'Manual QA Engineer. Выполнял ручное тестирование.',
      'Личный учебный проект: писал автотесты на Python и Pytest.',
    ].join('\n');
    const option = knownScreeningAnswer({
      id: 'commercial-python-option',
      prompt: 'Есть ли практический (коммерческий) опыт с автотестированием на python?',
      kind: 'multiple',
      options: ['Да', 'Нет'],
      required: false,
    }, null, resume);
    const text = knownScreeningAnswer({
      id: 'commercial-python-text',
      prompt: 'У Вас есть коммерческий опыт написания автотестов? С какими инструментами и в какой компании?',
      kind: 'text',
      options: [],
      required: false,
    }, null, resume);

    expect(option).toBeNull();
    expect(text).toBeNull();
  });

  it('does not turn prospective fintech interest into work experience', () => {
    expect(knownScreeningAnswer({
      id: 'fintech-interest',
      prompt: 'Имеется ли у вас опыт работы в финтехе/веб3 сферах?',
      kind: 'text',
      options: [],
      required: true,
    }, null, 'QA Engineer, интересуюсь финтехом и хочу работать в этой сфере.')).toBeNull();
    expect(knownScreeningAnswer({
      id: 'fintech-job-search',
      prompt: 'Имеется ли у вас опыт работы в финтехе/веб3 сферах?',
      kind: 'text',
      options: [],
      required: true,
    }, null, 'Ищу работу QA в Сбербанке.')).toBeNull();
  });

  it('does not treat a free-time automation project as commercial experience', () => {
    const resume = 'В свободное время разрабатывал автотесты на Python и Pytest.';
    expect(knownScreeningAnswer({
      id: 'commercial-hobby',
      prompt: 'У Вас есть коммерческий опыт написания автотестов?',
      kind: 'text', options: [], required: true,
    }, null, resume)).toBeNull();
  });

  it('does not invent personal AI usage without resume or confirmed evidence', () => {
    const answer = knownScreeningAnswer({
      id: 'ai', prompt: 'Вы используете в работе ИИ? Какие заджачи Вы решаете при помощи ИИ?', kind: 'text', options: [], required: false,
    }, null, '');
    expect(answer).toBeNull();
  });

  it('does not invent motivation or role interpretation without evidence', () => {
    const answer = knownScreeningAnswer({
      id: 'role', prompt: 'Что в предстоящих обязанностях заинтересовало вас больше всего и как понимаете роль?', kind: 'text', options: [], required: false,
    }, null, '');
    expect(answer).toBeNull();
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

  it('does not send unrelated zero-score facts to the screening model', () => {
    const unrelated = {
      question: 'Готовы ли вы к командировкам?',
      answer: 'Нет',
      selectedOptions: [],
    };
    const selected = selectRelevantScreeningFacts([unrelated], [{
      id: 'matrix', prompt: 'Работали ли вы с Matrix?', kind: 'text', options: [], required: true,
    }], 30);
    expect(selected).toEqual([]);
  });
});
