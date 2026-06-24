export interface QaGlossaryEntry {
  canonical: string;
  aliases: string[];
  /** Aliases that map only in QA interview context (e.g. "open" → OOP). */
  contextOnlyAliases?: string[];
}

export const QA_GLOSSARY: QaGlossaryEntry[] = [
  {
    canonical: 'CI/CD',
    aliases: [
      'си ай си ди',
      'си си ди',
      'сейчас сиди',
      'саседин',
      'cicd',
      'ci cd',
      'cfd',
      'aicd',
      'ai cd',
      'с aicd',
      'aicd и',
    ],
  },
  {
    canonical: 'Jenkins',
    aliases: ['джанкин', 'дженкин', 'дженкинс', 'джентленс', 'jumpkins'],
  },
  {
    canonical: 'GitLab CI',
    aliases: ['гитлаб си ай', 'gitlab ci', 'делатлавсиан', 'delatlavsian'],
  },
  {
    canonical: 'Docker',
    aliases: ['докер', 'доккер'],
  },
  {
    canonical: 'REST API',
    aliases: ['рест апи', 'rest api', 'аэроэстопе', 'растапья', 'рестапи'],
  },
  {
    canonical: 'pytest fixtures',
    aliases: [
      'пай тест фикстуры',
      'пайтест фикстуры',
      'pytest fixtures',
      'pytest-fit stura',
      'pytest fit stura',
      'pi test pixtures',
      'python с текстуром',
      'пайтон с текстуром',
      'pytest pictures',
      'пайтест пикчерс',
      'пай тест пикчерс',
    ],
  },
  {
    canonical: 'Page Object Model',
    aliases: [
      'page object model',
      'pages object model',
      'пейдж object model',
      'five job at model',
    ],
  },
  {
    canonical: 'Kafka',
    aliases: ['кафка', 'кавка', 'капитал', 'capcom'],
  },
  {
    canonical: 'Linux',
    aliases: [
      'линукс',
      'линзе',
      'linux',
      'полинулось',
      'что-то полинулось',
      'линици',
      'линицы',
      'леникс',
      'линикс',
      'линекс',
    ],
  },
  {
    canonical: 'Linux команды',
    aliases: [
      'линици команды',
      'линицы команды',
      'леникс команды',
      'линикс команды',
      'линукс команды',
      'linux commands',
      'linux команды',
    ],
  },
  {
    canonical: 'OOP',
    aliases: ['ооп', 'о о п', 'оп', 'о п', 'open', 'алопа', 'лололол'],
    contextOnlyAliases: ['open', 'оп', 'о п'],
  },
  {
    canonical: 'полиморфизм',
    aliases: [
      'полиморфизм',
      'полиматизм',
      'полимфорзим',
      'полимфоризм',
      'полиморфиз',
      'polymorphism',
      'polymorfism',
    ],
  },
  {
    canonical: 'инкапсуляция',
    aliases: ['инкапсуляция', 'инкапсуляци', 'encapsulation'],
  },
  {
    canonical: 'наследование',
    aliases: ['наследование', 'наследовани', 'inheritance'],
  },
  {
    canonical: 'абстракция',
    aliases: ['абстракция', 'абстракци', 'abstraction'],
  },
  {
    canonical: 'Allure Report',
    aliases: [
      'allure report',
      'аллюр репорт',
      'аллюр-репорт',
      'алур репорт',
      'алло report',
      'алло репорт',
      'alnu report',
      'алну report',
      'allnu report',
    ],
  },
  {
    canonical: 'Selenium',
    aliases: ['selenium', 'селениум', 'селenium'],
  },
  {
    canonical: 'Kubernetes',
    aliases: ['kubernetes', 'кубернетес', 'кубернетис', 'k8s'],
  },
  {
    canonical: 'HTTP methods',
    aliases: ['http methods', 'http методы', 'http-методы', 'методы http'],
  },
  {
    canonical: 'PUT',
    aliases: ['put метод', 'put request'],
    contextOnlyAliases: ['put'],
  },
  {
    canonical: 'PATCH',
    aliases: ['patch метод', 'patch request'],
    contextOnlyAliases: ['patch'],
  },
  {
    canonical: 'автотесты',
    aliases: ['ортотесты', 'auto tests', 'autotests'],
  },
  {
    canonical: 'баг',
    aliases: ['бак', 'bug'],
    contextOnlyAliases: ['бак'],
  },
  {
    canonical: 'критичный баг',
    aliases: ['критичный бак', 'критичный bag'],
  },
  {
    canonical: 'Playwright',
    aliases: ['playwright', 'плейрайт', 'плей райт', 'плей-прайд', 'плей прайд'],
  },
  {
    canonical: 'pipeline',
    aliases: ['пайплайн', 'pipeline'],
  },
  {
    canonical: 'smoke testing',
    aliases: ['smoke testing', 'smoke', 'смоук', 'смог'],
    contextOnlyAliases: ['smoke', 'смог'],
  },
  {
    canonical: 'regression testing',
    aliases: ['regression testing', 'regression', 'регрессион', 'pregration'],
  },
  {
    canonical: 'flaky tests',
    aliases: ['flaky tests', 'flaky test', 'flaky тесты', 'флейки', 'флаки'],
  },
];

export const QA_GLOSSARY_CANONICAL_TERMS = QA_GLOSSARY.map((e) => e.canonical);
