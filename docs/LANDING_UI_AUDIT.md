# SkillCue Landing UI/UX Audit

## Goal

Сделать `landing/index.html` не прототипной презентацией, а коротким продающим лендингом:
hero -> live demo -> сценарий -> ключевые фичи -> тарифы -> FAQ -> финальный CTA.

## Iteration 1 - Foundation

Проверено:
- Body/background
- Header/topbar
- Brand
- Navigation
- Buttons/CTA
- Keyboard focus
- Anchor navigation

Исправлено:
- Добавлен `skip-link` для клавиатурной навигации.
- Добавлены явные `:focus-visible` состояния.
- CTA получили hover/active states и нормальный `cursor`.
- Бренд и nav получили минимальные touch/focus размеры.
- Исправлены якоря: `#top`, `#main`, `#hero-demo`, `#how`, `#features`, `#pricing`, `#faq`.

## Iteration 2 - Hero And Demo

Проверено:
- Hero headline
- Hero subtext
- Primary/secondary CTA
- Live overlay preview
- Interview question
- Short answer cue
- Context pills

Исправлено:
- Hero оставлен максимально коротким: вакансия -> риски -> тренировка -> live-подсказка.
- Demo overlay усилен как главный объект страницы.
- Вопрос переписан в более реалистичный технический формат: `Что проверяли в API-тестах кроме статус-кода 200?`
- Ответ сокращён до настоящей live-подсказки, без длинной лекции.
- Context pills приведены к аккуратной иерархии: вакансия, резюме, готовность API.
- Главный CTA переведён с общего `Попробовать` на конкретное действие: `Разобрать вакансию бесплатно`.

## Iteration 3 - Product Flow And Feature Cards

Проверено:
- Section rhythm
- Timeline
- Step cards
- Feature cards
- Text hierarchy
- Product clarity

Исправлено:
- Процесс оставлен в 4 шага вместо перегруженного набора экранов.
- Каждый шаг отвечает на один вопрос пользователя:
  - что загрузить;
  - что SkillCue найдёт;
  - как понять готовность;
  - что видно на live.
- Feature cards переписаны без воды: план по вакансии, проверка ответов, компактный overlay.
- Удалён внутренний handoff-текст из пользовательского лендинга.
- Добавлены мягкие hover states для feature cards.

## Iteration 4 - Pricing, FAQ, Final CTA

Проверено:
- Pricing hierarchy
- Recommended plan
- CTA consistency
- FAQ usefulness
- Final conversion block

Исправлено:
- Тарифы стали честнее и понятнее: Free, Pro, Live.
- Recommended план визуально выделен без крика.
- FAQ переписан короче: роль продукта, live mode, конкретность ответов, что загрузить сначала.
- Финальный CTA сфокусирован на результате: вопросы, риски, готовность по темам.
- Добавлены micro-proof pills в финальном блоке.

## Iteration 5 - Responsive And QA

Проверено:
- Desktop 1440px
- Tablet 1024px
- Mobile 390px
- CSS braces
- Anchor integrity
- HTTP availability
- Text overflow
- Mobile demo overflow

Исправлено:
- Mobile hero получил контролируемые переносы.
- Demo overlay на mobile стал single-column.
- Чат-панель скрыта на mobile, чтобы главный cue не сжимался.
- Исправлен overflow текста в cue card.
- Answer cue сокращён до формата, который реально можно прочитать в overlay.
- Layout проверен через реальную CDP mobile-emulation: `clientWidth=390`, `scrollWidth=390`.
- Вторичный текст усилен по контрасту, чтобы нижние секции не выглядели “серым шумом”.

## Iteration 6 - Emotional Product Proof

Проверено:
- Hero value proposition
- First-screen conversion intent
- Result clarity after vacancy upload
- Dark/live vs prep/readiness visual modes

Исправлено:
- Hero subheadline усилен вокруг результата: вероятные вопросы, риски по навыкам, короткие подсказки.
- Secondary CTA заменён на `Посмотреть пример разбора`.
- Hero demo укрупнён, чтобы live-подсказка была главным объектом, а не декоративным widget.
- Добавлен светлый preparation-блок `Через 60 секунд после загрузки вакансии`.
- В новом блоке показаны конкретные результаты: 12 вопросов, 5 рисков, 78% готовность, 25-минутный план.
- Добавлен пример разбора вакансии с реалистичными вопросами и risk labels.

## Iteration 7 - Readiness And Pricing Clarity

Проверено:
- Готовность по навыкам как отдельная product feature
- Feature cards hierarchy
- Pricing value proof
- FAQ specificity

Исправлено:
- Добавлена отдельная `Карта готовности` со skill bars: опыт, API, CI/CD, проектные кейсы.
- Feature cards стали менее одинаковыми: подготовка выделена как primary value.
- Pricing переписан конкретнее: разборы вакансий, тренировки, карты готовности, desktop overlay.
- FAQ получил вопрос `Что я получу после загрузки вакансии?`.
- Финальный CTA обновлён вокруг рисков, вероятных вопросов и готовности по навыкам.

## Element Checklist

| Element | Status | Notes |
| --- | --- | --- |
| Background | OK | Dark, focused, не шумит. |
| Header | OK | Sticky desktop, simple mobile. |
| Logo | OK for MVP | Flexible working mark; не стоит пока строить бренд вокруг него. |
| Nav | OK | 4 пункта, без лишнего. |
| Primary CTA | OK | `Разобрать вакансию бесплатно` в hero and final. |
| Secondary CTA | OK | `Как это работает`, no competing primary. |
| Hero headline | OK | Clear promise, readable desktop/mobile. |
| Hero copy | OK | One sentence, product-specific. |
| Demo overlay | OK | Main product object, answer-first. |
| Interview question | OK | Realistic API question, no weak placeholder text. |
| Answer cue | OK | Short enough for live mode. |
| Context pills | OK | Useful, not decorative. |
| Timeline | OK | 4-step path, no icon clutter. |
| Result Snapshot | OK | Shows concrete outcome after vacancy upload. |
| Skill Readiness | OK | Dedicated readiness feature with topic percentages. |
| Feature cards | OK | Three concrete value props. |
| Pricing | OK for MVP | More concrete packaging; prices still placeholders. |
| FAQ | OK | Covers likely objections. |
| Final CTA | OK | Clear action and result. |
| Footer | OK | Minimal, no visual weight. |
| Accessibility | OK baseline | Skip link, focus-visible, valid anchors. |
| Mobile | OK baseline | CDP 390px: no horizontal overflow. |

## Remaining Product Decisions

- Prices are placeholders and should be validated.
- The product name `SkillCue` is still provisional.
- Real screenshots/video would improve conversion later, but current coded mock is acceptable for MVP.
