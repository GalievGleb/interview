#!/usr/bin/env bash
# Быстрая проверка «всё ли живо» на VPS SkillCue. Ничего не меняет, только читает.
# Запуск: ssh root@109.172.47.103 'bash /opt/skillcue/apps/api/deploy/status.sh'
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/skillcue}"
GW_PORT="$(grep -oP '(?<=^GATEWAY_PORT=)\d+' "$APP_DIR/gateway.env" 2>/dev/null || echo 8787)"

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

svc() {
  local name="$1"
  if systemctl is-active --quiet "$name"; then
    printf '  %-22s %s\n' "$name" "$(green active)"
  else
    printf '  %-22s %s\n' "$name" "$(red inactive)"
  fi
}

http() {
  local label="$1" url="$2"
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null)"
  printf '  %-22s HTTP %s\n' "$label" "$code"
}

echo "== SkillCue VPS status =="
date -u '+%Y-%m-%d %H:%M:%S UTC'

echo; echo "Сервисы:"
svc skillcue-gateway
svc skillcue-leadbot
svc redis-server
svc nginx
svc fail2ban

echo; echo "Эндпоинты:"
http "gateway /health" "http://127.0.0.1:${GW_PORT}/health"
http "магазин :80"     "http://127.0.0.1/"
http "магазин :8000"   "http://127.0.0.1:8000/"

echo; echo "Gateway health JSON:"
echo -n "  "; curl -s --max-time 5 "http://127.0.0.1:${GW_PORT}/health" || echo "недоступен"
echo

echo; echo "Учёт токенов (Redis):"
echo "  appendonly: $(redis-cli config get appendonly 2>/dev/null | tail -1)"
echo "  ключей расхода: $(redis-cli --scan --pattern 'gw:tok:*' 2>/dev/null | wc -l)"

echo; echo "fail2ban (sshd):"
fail2ban-client status sshd 2>/dev/null | grep -E 'Currently banned|Total banned' | sed 's/^/ /' || echo "  jail недоступен"

echo; echo "Лидбот — последняя строка лога:"
journalctl -u skillcue-leadbot --no-pager -n 1 --output=cat 2>/dev/null | sed 's/^/  /'

echo; echo "Ресурсы:"
free -m | awk '/Mem:/{printf "  RAM: %d/%d МБ занято, %d свободно\n",$3,$2,$7}'
df -h / | awk 'NR==2{printf "  Диск /: %s из %s занято (%s)\n",$3,$2,$5}'
