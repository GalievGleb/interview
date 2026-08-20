# Эксплуатация SkillCue на Raspberry Pi

Сервер: SSH alias `skillcue-pi` (`gleb@192.168.2.132`). Вход по SSH-ключу из
`~/.ssh/config`; административные команды выполняются через `sudo`.

## Что где

| Компонент | Путь | Сервис | Порт |
|-----------|------|--------|------|
| Гейтвей лицензий | `/opt/skillcue/apps/api` | `skillcue-gateway` | 8787 |
| Лидбот | `/opt/skillcue-leadbot` | `skillcue-leadbot` | — (long polling) |
| Redis (учёт токенов) | — | `redis-server` | 6379 (localhost) |
| Конфиг гейтвея (секреты) | `/opt/skillcue/gateway.env` | — | chmod 600 |

## Проверить статус (ничего не меняет)

```bash
ssh skillcue-pi 'sudo bash /opt/skillcue/apps/api/deploy/status.sh'
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
# для ключа sk-or-v1-* upstream обязан быть https://openrouter.ai/api/v1
sudo systemctl restart skillcue-gateway
curl -s http://127.0.0.1:8787/health   # upstreamConfigured должно стать true
```

## Выпустить лицензионный ключ покупателю

```bash
# admin-секрет лежит локально в apps/api/deploy/.admin_secret
curl -X POST http://127.0.0.1:8787/gateway/issue \
  -H "x-admin-secret: <секрет>" -H "Content-Type: application/json" \
  -d '{"email":"buyer@mail.com","plan":"max","days":30}'
```

Планы: `basic` (5M токенов/мес) или `max` (20M). `days` опционально (без него — бессрочный).

## Uptime-сторож (алерты в Telegram)

`monitor.sh` каждые 5 минут проверяет гейтвей/сайт/лидбот/redis/nginx, соответствие
ключа апстриму и остаток OpenRouter. При балансе ниже $1 или при смене состояния
пишет админу в Telegram без спама. Использует токен бота из
`/opt/skillcue-leadbot/config.json`.

```bash
sudo bash /opt/skillcue/apps/api/deploy/monitor.sh --test
sudo install -m 0644 apps/api/deploy/skillcue-monitor.cron /etc/cron.d/skillcue-monitor
sudo cat /etc/cron.d/skillcue-monitor
```

## Мониторинг расхода (счёт OpenRouter)

```bash
# сколько лицензий активно и токенов потрачено за текущий месяц
curl -s http://127.0.0.1:8787/gateway/stats -H "x-admin-secret: <секрет>" | python3 -m json.tool
# (публично: https://skill-cue.ru/gateway/stats с тем же заголовком)
```

## Обновить код

- **Гейтвей:** скопировать изменённые файлы `apps/api/src/**` → `cd /opt/skillcue/apps/api && npx tsc -p tsconfig.gateway.json && systemctl restart skillcue-gateway`.
- **Бот:** `scp tools/leadbot/leadbot.py skillcue-pi:/home/gleb/ && ssh skillcue-pi 'sudo install -o leadbot -g leadbot -m 0640 /home/gleb/leadbot.py /opt/skillcue-leadbot/leadbot.py && sudo systemctl restart skillcue-leadbot'`.
- **Полный передеплой:** запускать на Pi либо адаптировать deploy-команду под `skillcue-pi`; старый Beget больше не является production host.

## Домен + HTTPS (когда DNS `skill-cue.ru` доедет)

```bash
ssh skillcue-pi 'sudo DOMAIN=skill-cue.ru bash /opt/skillcue/apps/api/deploy/setup-web.sh'
```

Добавит домен соседним nginx-vhost + сертификат certbot. Магазин не трогает.

## Бэкапы

Включи снапшоты VPS в панели Beget (раздел Snapshots). Учёт токенов в Redis
durable (AOF включён), но снапшот сервера — страховка от всего сразу.
