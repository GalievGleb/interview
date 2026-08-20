#!/usr/bin/env bash
# SkillCue uptime-сторож: проверяет ключевые сервисы и пишет админу в Telegram
# ТОЛЬКО при смене состояния (упало / восстановилось) — без спама каждые 5 минут.
# Запуск по cron: */5 * * * * bash /opt/skillcue/apps/api/deploy/monitor.sh
set -uo pipefail

STATE=/var/lib/skillcue-monitor.state
CFG=/opt/skillcue-leadbot/config.json
TOKEN=$(python3 -c "import json;print(json.load(open('$CFG'))['bot_token'])" 2>/dev/null)
ADMIN=$(python3 -c "import json;print(json.load(open('$CFG'))['admin_chat_id'])" 2>/dev/null)

problems=""
check() { if ! eval "$2" >/dev/null 2>&1; then problems="${problems}
• $1"; fi; }

check "гейтвей /health"      "curl -fsS --max-time 8 http://127.0.0.1:8787/health | grep -q '\"ok\":true'"
check "LLM-провайдер или баланс OpenRouter" \
  "python3 /opt/skillcue/apps/api/deploy/provider_health.py --env /opt/skillcue/gateway.env --warning-threshold 1.0"
check "сайт skill-cue.ru"    "curl -fskS --max-time 10 -o /dev/null https://skill-cue.ru/"
check "лидбот"               "systemctl is-active --quiet skillcue-leadbot"
check "redis"                "systemctl is-active --quiet redis-server"
check "nginx"                "systemctl is-active --quiet nginx"

now="ok"; [ -n "$problems" ] && now="down"
prev=$(cat "$STATE" 2>/dev/null || echo "ok")
echo "$now" > "$STATE"

send() {
  [ -z "${TOKEN:-}" ] && return 0
  curl -fsS --max-time 10 "https://api.telegram.org/bot$TOKEN/sendMessage" \
    --data-urlencode "chat_id=$ADMIN" --data-urlencode "text=$1" >/dev/null 2>&1
}

ts=$(date -u '+%d.%m %H:%M UTC')
if [ "$now" = "down" ] && [ "$prev" = "ok" ]; then
  send "🔴 SkillCue — проблема на сервере (${ts}):${problems}"
elif [ "$now" = "ok" ] && [ "$prev" = "down" ]; then
  send "🟢 SkillCue — всё восстановилось (${ts})."
fi

# --setup: одноразовая проверка, что канал уведомлений вообще работает
if [ "${1:-}" = "--test" ]; then
  send "🟢 Мониторинг SkillCue включён (${ts}). Буду писать сюда, если что-то упадёт."
fi
