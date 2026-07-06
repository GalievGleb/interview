# Эксплуатация SkillCue на VPS

Сервер: `root@109.172.47.103` (Beget, Ubuntu 24.04). Вход по SSH-ключу.
Рядом живёт чужой проект владельца (магазин на :80 + Swagger на :8000) — **не трогать**.

## Что где

| Компонент | Путь | Сервис | Порт |
|-----------|------|--------|------|
| Гейтвей лицензий | `/opt/skillcue/apps/api` | `skillcue-gateway` | 8787 |
| Лидбот | `/opt/skillcue-leadbot` | `skillcue-leadbot` | — (long polling) |
| Redis (учёт токенов) | — | `redis-server` | 6379 (localhost) |
| Конфиг гейтвея (секреты) | `/opt/skillcue/gateway.env` | — | chmod 600 |

## Проверить статус (ничего не меняет)

```bash
ssh root@109.172.47.103 'bash /opt/skillcue/apps/api/deploy/status.sh'
```

## Логи

```bash
journalctl -u skillcue-gateway -f      # гейтвей
journalctl -u skillcue-leadbot -f      # бот
```

## Перезапуск / рестарт

```bash
systemctl restart skillcue-gateway
systemctl restart skillcue-leadbot
```

## Добавить/сменить ключ OpenRouter (нужен для ответов покупателям)

```bash
# в gateway.env строка OPENROUTER_API_KEY=... ; затем:
systemctl restart skillcue-gateway
curl -s http://127.0.0.1:8787/health   # upstreamConfigured должно стать true
```

## Выпустить лицензионный ключ покупателю

```bash
# admin-секрет лежит локально в apps/api/deploy/.admin_secret
curl -X POST http://109.172.47.103:8787/gateway/issue \
  -H "x-admin-secret: <секрет>" -H "Content-Type: application/json" \
  -d '{"email":"buyer@mail.com","plan":"max","days":30}'
```

Планы: `basic` (5M токенов/мес) или `max` (20M). `days` опционально (без него — бессрочный).

## Обновить код

- **Гейтвей:** скопировать изменённые файлы `apps/api/src/**` → `cd /opt/skillcue/apps/api && npx tsc -p tsconfig.gateway.json && systemctl restart skillcue-gateway`.
- **Бот:** `scp tools/leadbot/leadbot.py root@…:/opt/skillcue-leadbot/ && ssh … 'chown leadbot:leadbot /opt/skillcue-leadbot/leadbot.py && systemctl restart skillcue-leadbot'`.
- **Полный передеплой:** `py -3.12 apps/api/deploy/deploy.py --host 109.172.47.103 --user root`.

## Домен + HTTPS (когда DNS `skill-cue.ru` доедет)

```bash
ssh root@109.172.47.103 'DOMAIN=skill-cue.ru bash /opt/skillcue/apps/api/deploy/setup-web.sh'
```

Добавит домен соседним nginx-vhost + сертификат certbot. Магазин не трогает.

## Бэкапы

Включи снапшоты VPS в панели Beget (раздел Snapshots). Учёт токенов в Redis
durable (AOF включён), но снапшот сервера — страховка от всего сразу.
