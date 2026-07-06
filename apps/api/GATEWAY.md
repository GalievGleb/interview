# SkillCue Gateway — серверный прокси для продаж без BYOK

Покупатель вводит в приложении **только лицензионный ключ** — свои API-ключи
OpenRouter ему не нужны. Десктопный бэкенд сам направляет LLM-запросы через
гейтвей, когда ключа OpenRouter нет, а валидная лицензия есть.

## Как это работает

```
Desktop (api-py) ──Bearer SKILLCUE-…──▶ Gateway /v1/chat/completions ──▶ OpenRouter
                                          │ Ed25519-проверка ключа (офлайн, без БД)
                                          │ месячный токен-бюджет тарифа в Redis
                                          └ ключ OpenRouter живёт ТОЛЬКО на сервере
```

- Эндпоинты OpenAI-совместимые: `POST /v1/chat/completions` (stream и нет),
  `GET /v1/models` (кэш 10 мин), `GET /v1/usage` (расход ключа за месяц).
- Обрыв клиента посреди стрима абортит апстрим (не платим за невидимые токены).
- `GET /gateway/stats` (заголовок `x-admin-secret`) — сколько лицензий активно и
  токенов потрачено за месяц (мониторинг счёта OpenRouter): `{month, activeLicenses,
  totalTokens, top[]}`. Email не хранится, только анонимные id ключей.
- Бюджеты тарифов зеркалят `apps/api-py/app/services/license.py`:
  basic 5M, max 20M токенов/мес; `tokens_month` в ключе переопределяет.
- Учёт: точный из usage-чанка стрима (`stream_options.include_usage`),
  фолбэк — оценка по символам. Ключ Redis: `gw:tok:<id>:<YYYY-MM>`.
- Rate limit: 60 запросов/мин на ключ.

## Деплой (любой VPS с Docker)

```bash
cd apps/api
pnpm install && pnpm build          # nest build → dist/
# env (см. ниже) + redis рядом, затем:
node dist/main.js
```

Обязательные переменные окружения:

| Переменная | Что это |
|---|---|
| `OPENROUTER_API_KEY` | апстрим-ключ издателя (расходы идут с него) |
| `REDIS_URL` | `redis://…` (учёт расхода и rate limit) |
| `LICENSE_PUBLIC_KEY_HEX` | публичный ключ подписи лицензий (дефолт зашит — тот же, что в api-py) |
| `GATEWAY_ADMIN_SECRET` | секрет для `/gateway/issue` |
| `LICENSE_PRIVATE_KEY_HEX` | приватный ключ подписи (нужен только для issue; тот же, что `.license_signing_key`) |
| `GATEWAY_UPSTREAM_BASE` | (опц.) апстрим вместо OpenRouter |
| `GATEWAY_BLOCKED_MODELS` | (опц., РЕКОМЕНДУЕТСЯ) запрет дорогих моделей через запятую, напр. `openai/gpt-5.5,anthropic/claude-opus`. Приоритетнее allowlist, матч по префиксу. **Зачем:** бюджет в токенах, но дорогая модель тратит в ~100× больше денег — блок не даёт покупателю выжечь бюджет через Opus/gpt-5.5 и разорить владельца. При запрете — 403 `model_not_allowed`. |
| `GATEWAY_ALLOWED_MODELS` | (опц.) whitelist «только эти модели». Пусто = разрешены все (кроме блоклиста). Удобен, когда нужен узкий список. |

> Если блокируешь модель, убедись, что приложение не запрашивает её по умолчанию —
> иначе фича упрётся в 403. Дефолт разбора вакансии — `model_router.VACANCY_DEFAULT_MODEL`.

## Выпуск ключей

```bash
curl -X POST https://<host>/gateway/issue \
  -H "x-admin-secret: $GATEWAY_ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"email":"buyer@mail.com","plan":"max","days":30}'
# → {"key":"SKILLCUE-…"}
```

Вебхук оплаты (ЮKassa/Stripe — модули уже в `src/billing/`) при успешном платеже
вызывает ту же `mintLicenseKey()` и шлёт ключ покупателю на почту. Это единственный
недостающий кусок — он требует аккаунта платёжного провайдера.

## Подключение десктопа

В `apps/api-py/.env` сборки издателя:

```
SKILLCUE_GATEWAY_URL=https://<host>/v1
```

Логика (`provider_adapter._resolve`): есть свой ключ OpenRouter → работаем как
раньше (BYOK); ключа нет, но есть валидная лицензия → запросы через гейтвей с
лицензией как Bearer. Пользователь ничего не настраивает.

## Проверка совместимости подписи

```bash
npx tsx scripts/license-crosscheck.ts   # NODE_SELF_VERIFY_OK + PUB/KEY
# затем PY-проверку см. в истории: ключ из Node обязан проходить
# app.services.license.verify_license_key в api-py (проверено 2026-07-05).
```

## Что осталось до продакшена

1. Аккаунт ЮKassa/Stripe → вебхук в `billing` → `mintLicenseKey` + письмо.
2. TLS/домен (обычный reverse-proxy, например Caddy).
3. Мониторинг расхода апстрим-ключа (алерт при аномалии).
