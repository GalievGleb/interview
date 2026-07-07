/**
 * Сигналы под конкретный технический КОНЦЕПТ из текста вопроса — для локальной
 * (без AI) оценки ответа в mock-интервью.
 *
 * Проблема, которую решает модуль: без него локальная оценка грейдит вопрос по
 * generic-пунктам всей ТЕМЫ (например, вопрос про контекстный менеджер — по
 * «Базовые типы, ООП, comprehensions» темы «Основы Python»), и верный узкий
 * ответ получает 0 покрытия. Ключ — сам ВОПРОС, а не тема.
 *
 * Data-driven: список {match, signals}. Первое совпадение выигрывает, поэтому
 * порядок = от узкого к общему. Покрыты частые домены собеседований: Python,
 * JS/Frontend, SQL/БД, Docker/контейнеры, REST/API, CI/CD, system design.
 *
 * ВАЖНО про regex: `\w` в JS НЕ матчит кириллицу — у русских основ суффикс
 * пишем через `[а-я]*`, а не `\w*` (иначе «контекстн\w* менеджер» не ловит
 * «контекстный менеджер»). Текст на входе нормализован (lowercase, ё→е).
 */

export interface ConceptRule {
  /** Ключ концепта (для тестов/диагностики). */
  id: string;
  /** Совпадение по нормализованному тексту вопроса. */
  match: RegExp;
  /** Сигналы-ожидания, по которым грейдится ответ. */
  signals: string[];
}

/** Нормализация как в vacancyReviewService.norm — держим согласованной. */
export function normConcept(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[–—]/g, '-');
}

const EXAMPLE = 'пример из практики';

export const CONCEPT_RULES: ConceptRule[] = [
  // ---------- Python ----------
  {
    id: 'py.context_manager',
    match: /(контекстн[а-я]* менеджер|context manager|\bwith\b|__enter__|__exit__|contextlib)/,
    signals: [
      'протокол __enter__ / __exit__',
      'оператор with',
      'гарантированное освобождение ресурса (файлы, соединения, локи)',
      'contextlib / @contextmanager',
      EXAMPLE,
    ],
  },
  {
    id: 'py.decorator',
    match: /(декоратор|decorator|@wraps|functools)/,
    signals: [
      'функция, оборачивающая другую функцию',
      'синтаксис @ и замыкание',
      'functools.wraps для сохранения метаданных',
      'типичные применения (логирование, кэш, замер времени, доступ)',
      EXAMPLE,
    ],
  },
  {
    id: 'py.generator',
    match: /(генератор|generator|\byield\b|итератор|iterator|__next__)/,
    signals: [
      'ленивая генерация значений (yield)',
      'экономия памяти на больших данных',
      'протокол итератора __iter__ / __next__',
      'отличие от списка',
      EXAMPLE,
    ],
  },
  {
    id: 'py.gil',
    match: /\bgil\b|глобальн[а-я]* блокировк|global interpreter lock/,
    signals: [
      'одна нить исполняет байткод в момент времени',
      'потоки vs процессы',
      'узкое место на CPU-bound задачах',
      'обход через multiprocessing / нативные расширения / async для IO',
      EXAMPLE,
    ],
  },
  {
    id: 'py.mutability',
    match: /(изменяем[а-я]*|неизменяем[а-я]*|mutable|immutable|list.*tuple|tuple.*list)/,
    signals: [
      'изменяемые (list, dict, set) vs неизменяемые (tuple, str, frozenset)',
      'последствия для передачи в функции',
      'ловушка изменяемого аргумента по умолчанию',
      'хешируемость и ключи словаря',
      EXAMPLE,
    ],
  },
  {
    id: 'py.exceptions',
    match: /(исключени|exception|try.*except|обработк[а-я]* ошибок)/,
    signals: [
      'try / except / else / finally',
      'иерархия исключений и точечный перехват',
      'собственные классы исключений',
      'подход EAFP vs LBYL',
      EXAMPLE,
    ],
  },

  // ---------- JS / Frontend ----------
  {
    id: 'js.closure',
    match: /(замыкани|closure)/,
    signals: [
      'функция помнит лексическое окружение',
      'доступ к переменным внешней функции после её возврата',
      'приватное состояние без классов',
      'типичная ловушка в циклах (var vs let)',
      EXAMPLE,
    ],
  },
  {
    id: 'js.event_loop',
    match: /(event loop|событийн[а-я]* цикл|микротаск|macrotask|promise.*settimeout|асинхронност[а-я]* в js)/,
    signals: [
      'call stack, очередь задач и микрозадач',
      'порядок: синхронный код → микротаски (Promise) → макротаски (setTimeout)',
      'однопоточность и неблокирующий IO',
      'async/await поверх промисов',
      EXAMPLE,
    ],
  },
  {
    id: 'react.hooks',
    match: /(usestate|useeffect|\bhooks?\b|хук[аи]?\b|usememo|usecallback)/,
    signals: [
      'состояние и жизненный цикл в функциональных компонентах',
      'массив зависимостей useEffect',
      'правила хуков (только на верхнем уровне)',
      'мемоизация useMemo/useCallback против лишних рендеров',
      EXAMPLE,
    ],
  },
  {
    id: 'react.render',
    match: /(virtual dom|виртуальн[а-я]* dom|реконсиляц|reconciliation|перерисовк[а-я]*|ре-?рендер)/,
    signals: [
      'virtual DOM и диффинг',
      'ключи (key) в списках',
      'причины лишних ре-рендеров',
      'мемоизация (memo, useMemo) и оптимизация',
      EXAMPLE,
    ],
  },

  // ---------- SQL / БД ----------
  {
    id: 'sql.join',
    match: /(\bjoin\b|джойн|inner join|left join|соединени[ея] таблиц)/,
    signals: [
      'INNER vs LEFT/RIGHT/FULL',
      'условие ON и связь по ключам',
      'дубли строк и их причина',
      'производительность и индексы под join',
      EXAMPLE,
    ],
  },
  {
    id: 'sql.index',
    match: /(индекс|\bindex\b|b-?tree|ускор[а-я]* запрос)/,
    signals: [
      'зачем индекс: ускорение поиска',
      'B-tree и когда индекс НЕ используется',
      'цена на запись и объём',
      'составные индексы и порядок колонок',
      EXAMPLE,
    ],
  },
  {
    id: 'sql.transaction',
    match: /(транзакци|transaction|\bacid\b|уровн[а-я]* изоляц|isolation level|deadlock|блокировк[а-я]* строк)/,
    signals: [
      'ACID-свойства',
      'уровни изоляции и аномалии (dirty/phantom read)',
      'commit/rollback',
      'блокировки и deadlock',
      EXAMPLE,
    ],
  },
  {
    id: 'sql.optimization',
    match: /(оптимизаци[а-я]* запрос|медленн[а-я]* запрос|explain|план запрос|query plan|n\+1)/,
    signals: [
      'EXPLAIN / план выполнения',
      'индексы под условие и join',
      'проблема N+1 и батчинг',
      'выборка только нужных колонок, пагинация',
      EXAMPLE,
    ],
  },

  // ---------- Docker / контейнеры ----------
  {
    id: 'docker.basics',
    match: /(docker|докер|контейнер|dockerfile|образ[а-я]* и контейнер|image.*container)/,
    signals: [
      'образ vs контейнер',
      'слои образа и кэш сборки',
      'Dockerfile: FROM/COPY/RUN/CMD',
      'изоляция и воспроизводимое окружение',
      EXAMPLE,
    ],
  },
  {
    id: 'k8s.basics',
    match: /(kubernetes|кубернет|k8s|\bpod\b|под[аы]\b|оркестрац)/,
    signals: [
      'pod, deployment, service',
      'масштабирование и самовосстановление',
      'конфигурация (configmap/secret)',
      'когда нужен оркестратор',
      EXAMPLE,
    ],
  },

  // ---------- REST / API ----------
  {
    // Узко про REST-ДИЗАЙН (методы, идемпотентность), а НЕ про API-ТЕСТИРОВАНИЕ
    // («что проверяете в API кроме 200») — последнее QA-тема, у неё свои точные
    // пункты (schema/auth/negative), их подменять generic-дизайном нельзя.
    id: 'api.rest',
    match: /(\brest\b|restful|http-?метод|idempoten|идемпотентн|семантик[а-я]* http)/,
    signals: [
      'ресурсы и HTTP-методы (GET/POST/PUT/PATCH/DELETE)',
      'идемпотентность и семантика методов',
      'статус-коды (2xx/4xx/5xx)',
      'версионирование и контракт ответа',
      EXAMPLE,
    ],
  },
  {
    id: 'api.auth',
    match: /(аутентификац|авторизац|\bjwt\b|oauth|токен[а-я]* доступ|session.*cookie)/,
    signals: [
      'аутентификация vs авторизация',
      'JWT / сессии / OAuth — когда что',
      'хранение и срок жизни токена',
      'типичные уязвимости (утечка токена, CSRF)',
      EXAMPLE,
    ],
  },

  // ---------- System design ----------
  {
    id: 'sysdesign.scaling',
    match: /(масштабир|scaling|горизонтальн[а-я]* масштаб|балансировщик|load balanc|кэширован|caching|высок[а-я]* нагрузк)/,
    signals: [
      'вертикальное vs горизонтальное масштабирование',
      'балансировка нагрузки',
      'кэширование (уровни, инвалидация)',
      'узкие места: БД, сеть, состояние',
      EXAMPLE,
    ],
  },
];

/**
 * Сигналы под конкретный концепт из вопроса; null, если ничего не распознали
 * (тогда вызывающий откатывается на generic-пункты темы).
 */
export function conceptSignalsForQuestion(question: string): string[] | null {
  const q = normConcept(question);
  for (const rule of CONCEPT_RULES) {
    if (rule.match.test(q)) return rule.signals;
  }
  return null;
}
