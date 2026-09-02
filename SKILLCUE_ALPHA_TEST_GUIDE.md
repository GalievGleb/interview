# SkillCue Alpha — как проверить typed screen

## Что установлено

- Приложение: `C:\Users\gleb\AppData\Local\Programs\skillcue-alpha\SkillCue Alpha.exe`
- Данные: `C:\Users\gleb\AppData\Roaming\SkillCue Alpha`
- Локальный backend: `http://127.0.0.1:8002`
- Установщик: `C:\Users\gleb\Projects\SkillCue\apps\desktop\release-alpha\SkillCue-Alpha-Setup.exe`
- Alpha не заменяет `SkillCue` и `SkillCue Dev`; у неё отдельные App ID, protocol `skillcue-alpha`, порт и профиль.

## Что такое typed/structured screen

Обычный screen assist передавал модели несколько картинок и прошлый свободный текст, а модель одновременно читала экран, объединяла контекст и писала ответ. При прокрутке она могла забыть вывод с первого кадра или сохранить лишнюю старую реализацию.

Alpha использует двухступенчатый контур:

1. Новый кадр превращается в ограниченное типизированное наблюдение.
2. Приложение хранит в памяти ledger подтверждённых фактов и требований.
3. Новые кадры дополняют ledger; отсутствие старого факта на новом кадре его не удаляет.
4. Ответ строится из объединённого ledger.
5. Код и чек-листы проверяются до показа; невалидный ответ не становится новым состоянием задачи.
6. Картинки и typed state не пишутся в базу или отчёты; они живут только в памяти и очищаются при новой задаче/закрытии/истечении TTL.

## Быстрая ручная проверка

1. Откройте `SkillCue Alpha` и убедитесь, что в диспетчере задач/панели задач указано именно **SkillCue Alpha**.
2. Откройте live overlay сочетанием `Ctrl+Shift+H`.
3. Подготовьте на экране текст задачи и нажмите `Ctrl+Shift+Enter` — это принудительный запрос по скриншоту.
4. Для продолжения прокрутите тот же документ и снова нажмите `Ctrl+Shift+Enter`.
5. Для несвязанной задачи нажмите в overlay **«Новая задача с экрана»**: старый ledger не должен перейти в новый ответ.

### Проверка памяти между кадрами

На первом экране покажите:

```text
Ревью конфигурации. Дефект A: job build печатает echo вместо реальной сборки.
Найди дефекты и сохрани их при продолжении.
```

После первого ответа замените/прокрутите экран до:

```text
Продолжение той же конфигурации. Дефект B: cleanup удаляет tag вместо cache.
Объедини выводы со всех видимых кадров.
```

Ожидание: второй ответ содержит и A, и B. Если остаётся только B — continuity не прошла.

### Проверка простой Python/SQL-задачи

Покажите задачу:

```text
Сохрани сигнатуру:
def get_order(conn, order_id: int) -> list[dict[str, Any]]

Верни запись из таблицы Order по id. Используй один параметризованный SELECT.
Без JOIN, CTE, вспомогательных классов и лишних функций.
Перед кодом дай короткий план по-русски; комментарий к строке кода пиши следующей строкой.
```

Ожидание: одна функция, один отдельно параметризованный SELECT, сохранённая сигнатура, один code fence, нет лишней архитектуры. Небезопасная подстановка `order_id` в строку должна быть отклонена/исправлена.

### Проверка checklist

Покажите описание API-операции и попросите: `Дай ровно 5 проверок endpoint`. Затем на том же экране: `Дай ровно 3 новые бизнес-проверки, не повторяй первые и не предлагай прямые проверки БД`.

Ожидание: сначала ровно 5 пунктов, затем ровно 3 новых; без дублей и без прямого доступа к БД.

## Автоматическая проверка installed Alpha

Один privacy-safe прогон трёх экранных сценариев:

```powershell
Set-Location C:\Users\gleb\Projects\SkillCue
.\apps\api-py\.venv\Scripts\python.exe tools\verify_screen_code_task.py `
  --channel alpha `
  --structured-screen `
  --real-interview-regressions `
  --repetitions 1 `
  --report output\verification\real-interview-overlay\screen-live-alpha-installed-one.json
```

Финальный acceptance после успешного одиночного прогона:

```powershell
.\apps\api-py\.venv\Scripts\python.exe tools\verify_screen_code_task.py `
  --channel alpha `
  --structured-screen `
  --real-interview-regressions `
  --repetitions 3 `
  --report output\verification\real-interview-overlay\screen-live-alpha-installed-3x3.json
```

Проходной результат: `SCREEN REGRESSION SUITE PASS`, 9 попыток, 0 failed, все semantic checks `true`, без retry/provider/truncation ошибок.

## Текущий честный статус

- Локальная архитектура, схемы, merge, validators, desktop lifecycle и Alpha-channel проходят автоматические тесты.
- Alpha собрана, установлена, запускает свой backend на порту 8002 и отвечает `health=ok`.
- Первый installed live-screen прогон сейчас останавливается на внешнем managed gateway с `provider_error` до наблюдения кадра. Это означает: локальная Alpha установлена правильно, но реальный AI-контур ещё нельзя считать готовым.
- Серверные gateway-изменения намеренно не выкладывались, потому что запрос был сделать только локальную Alpha. До отдельного разрешения на gateway deploy или настройки отдельного рабочего BYOK нельзя обещать успешный live screen.
- Последний полноценный live 3×3 до Alpha проходил только 5/9, поэтому Alpha — тестовый канал, не готовый Stable-релиз.

## Как удалить Alpha

Windows → Параметры → Приложения → Установленные приложения → **SkillCue Alpha** → Удалить. Stable и Dev останутся отдельно. Данные Alpha хранятся в `C:\Users\gleb\AppData\Roaming\SkillCue Alpha` и установщик по умолчанию их не удаляет.
