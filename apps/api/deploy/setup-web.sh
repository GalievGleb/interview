#!/usr/bin/env bash
# Публикация SkillCue на домене РЯДОМ с уже живущим на сервере проектом.
#
# Сценарий: на :80 уже крутится другой сайт владельца (тестовый магазин).
# Мы НЕ трогаем его как сайт по умолчанию, а добавляем name-based виртуальный
# хост для $DOMAIN: лендинг + прокси /v1|/gateway на гейтвей :8787.
#
#   DOMAIN=skill-cue.ru bash setup-web.sh
#
# Поддерживает два случая:
#   1) :80 занят nginx  -> добавляем nginx-vhost + certbot TLS.
#   2) :80 свободен     -> ставим Caddy на домен (TLS сам).
# Если :80 занят НЕ nginx (docker/node напрямую) — скрипт останавливается и
# печатает, кто держит порт: тогда решаем руками, не ломая чужой процесс.
set -euo pipefail

DOMAIN="${DOMAIN:?Укажи DOMAIN=skill-cue.ru}"
APP_DIR="${APP_DIR:-/opt/skillcue}"
GW_PORT="$(grep -oP '(?<=^GATEWAY_PORT=)\d+' "$APP_DIR/gateway.env" || echo 8787)"
ACCOUNT_PORT="$(grep -oP '(?<=^ACCOUNT_API_PORT=)\d+' "$APP_DIR/account.env" 2>/dev/null || echo 8788)"

holder="$(ss -ltnp 2>/dev/null | awk '$4 ~ /:80$/{print $6; exit}')"

if command -v nginx >/dev/null && [[ "${holder:-}" == *nginx* ]]; then
  echo "== :80 держит nginx — добавляю vhost $DOMAIN (магазин не трогаю)"
  cat > "/etc/nginx/sites-available/skillcue.conf" <<NGINX
limit_req_zone \$binary_remote_addr zone=skillcue_account:10m rate=30r/m;

server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;
    # A 120-second native-rate mono PCM16 mock answer is up to ~22 MiB.
    client_max_body_size 25m;

    root $APP_DIR/landing;
    index index.html;

    location /v1/ {
        proxy_pass http://127.0.0.1:$GW_PORT;
        proxy_set_header Host \$host;
        proxy_buffering off;          # SSE-стримы гейтвея
        proxy_read_timeout 300s;
    }
    location /gateway/ {
        proxy_pass http://127.0.0.1:$GW_PORT;
        proxy_set_header Host \$host;
    }
    location /account/billing/webhooks/ {
        proxy_pass http://127.0.0.1:$ACCOUNT_PORT/billing/webhooks/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
    location /account/ {
        limit_req zone=skillcue_account burst=20 nodelay;
        proxy_pass http://127.0.0.1:$ACCOUNT_PORT/;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
    location / {
        # \$uri.html — чтобы «чистые» URL без .html работали (напр. /requisites).
        try_files \$uri \$uri.html \$uri/ /index.html;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/skillcue.conf /etc/nginx/sites-enabled/skillcue.conf
  nginx -t && systemctl reload nginx
  echo "== HTTP-vhost готов. TLS:"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos \
    -m "admin@$DOMAIN" --redirect || echo "!! certbot не смог (DNS ещё не доехал?) — повтори позже: certbot --nginx -d $DOMAIN"
elif [ -z "${holder:-}" ]; then
  echo "== :80 свободен — ставлю Caddy (TLS сам)"
  if ! command -v caddy >/dev/null; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN, www.$DOMAIN {
    encode gzip
    @api path /v1/* /gateway/*
    reverse_proxy @api 127.0.0.1:$GW_PORT
    handle_path /account/* {
        reverse_proxy 127.0.0.1:$ACCOUNT_PORT
    }
    root * $APP_DIR/landing
    file_server
}
CADDY
  systemctl enable --now caddy
  systemctl reload caddy || systemctl restart caddy
else
  echo "!! :80 занят процессом, который я не буду трогать автоматически:"
  echo "   $holder"
  echo "   Разбираемся вручную (docker-контейнер? node?) — см. GATEWAY.md."
  exit 2
fi

echo "== проверка:"
curl -s -o /dev/null -w "  http://$DOMAIN/          -> HTTP %{http_code}\n" -H "Host: $DOMAIN" http://127.0.0.1/ || true
curl -s -o /dev/null -w "  http://$DOMAIN/v1/models -> HTTP %{http_code} (401 = гейтвей жив, ждёт ключ)\n" -H "Host: $DOMAIN" http://127.0.0.1/v1/models || true
