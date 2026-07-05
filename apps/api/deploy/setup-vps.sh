#!/usr/bin/env bash
# SkillCue VPS bootstrap: гейтвей лицензий + Redis + Telegram-лидбот.
# Идемпотентный: повторный запуск обновляет код и перезапускает сервисы.
# Ожидает: бандл распакован в $APP_DIR, env-файл лежит в $APP_DIR/gateway.env.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/skillcue}"
NODE_MAJOR=22

log() { echo "== $*"; }

# --- система ---------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
log "apt: базовые пакеты"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg redis-server python3 >/dev/null

# swap на маленьких VPS: сборка NestJS на 1ГБ без него падает по OOM
if [ ! -f /swapfile ] && [ "$(free -m | awk '/Mem:/{print $2}')" -lt 1800 ]; then
  log "swap 2G (мало RAM)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- Node 22 + pnpm ---------------------------------------------------------
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]; then
  log "Node $NODE_MAJOR (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
command -v pnpm >/dev/null || npm install -g pnpm@9 --silent

# --- Redis ------------------------------------------------------------------
systemctl enable --now redis-server
redis-cli ping | grep -q PONG && log "Redis OK"

# --- сборка гейтвея ---------------------------------------------------------
cd "$APP_DIR"
log "pnpm install (workspace)"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
log "prisma generate (нужен только для компиляции старых модулей)"
(cd apps/api && npx prisma generate >/dev/null)
log "build shared + api"
pnpm --filter @interview/shared build
pnpm --filter @interview/api build
test -f apps/api/dist/gateway-main.js && log "gateway build OK"

# --- systemd: гейтвей -------------------------------------------------------
cat > /etc/systemd/system/skillcue-gateway.service <<UNIT
[Unit]
Description=SkillCue license gateway
After=network-online.target redis-server.service
Wants=redis-server.service

[Service]
WorkingDirectory=$APP_DIR/apps/api
EnvironmentFile=$APP_DIR/gateway.env
ExecStart=$(command -v node) dist/gateway-main.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT

# --- systemd: лидбот ---------------------------------------------------------
cat > /etc/systemd/system/skillcue-leadbot.service <<UNIT
[Unit]
Description=SkillCue Telegram lead bot
After=network-online.target

[Service]
WorkingDirectory=$APP_DIR/tools/leadbot
ExecStart=$(command -v python3) $APP_DIR/tools/leadbot/leadbot.py
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now skillcue-gateway skillcue-leadbot
sleep 3
systemctl --no-pager --lines=0 status skillcue-gateway | head -3
systemctl --no-pager --lines=0 status skillcue-leadbot | head -3

# --- ВАЖНО: веб-часть (лендинг/домен) настраивается ОТДЕЛЬНО -------------------
# На сервере уже может жить другой проект на :80 (у владельца — тестовый магазин
# со Swagger). Этот скрипт порт 80 НЕ трогает: он поднимает только gateway:8787,
# Redis и лидбота. Публикация лендинга на домене — setup-web.sh (после осмотра
# того, чем занят :80).
GW_PORT="$(grep -oP '(?<=^GATEWAY_PORT=)\d+' "$APP_DIR/gateway.env" || echo 8787)"
log ":80 сейчас слушает:"
ss -ltnp 2>/dev/null | awk '$4 ~ /:80$|:443$/{print "   ", $4, $6}' || true

# --- smoke -------------------------------------------------------------------
sleep 2
curl -s -o /dev/null -w "gateway /v1/models (no auth) -> HTTP %{http_code}\n" "http://127.0.0.1:${GW_PORT}/v1/models"
log "готово (веб-слой: apps/api/deploy/setup-web.sh)"
