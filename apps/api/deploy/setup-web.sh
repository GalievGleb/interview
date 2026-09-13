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

# Production runs through a remotely managed Cloudflare Tunnel into the
# hardened loopback nginx listener on the Raspberry Pi. Preserve that vhost
# and add only the account routes; do not replace it with a public :80 server.
PI_NGINX_AVAILABLE="/etc/nginx/sites-available/skillcue.conf"
PI_NGINX_ENABLED="/etc/nginx/sites-enabled/skillcue.conf"
PI_NGINX_BACKUP_DIR="$APP_DIR/backups/nginx-account-route"
PI_NGINX_ACTIVE_BACKUP="$PI_NGINX_BACKUP_DIR/active.conf.before-account"
PI_NGINX_AVAILABLE_BACKUP="$PI_NGINX_BACKUP_DIR/available.conf.before-account"
PI_NGINX_CONF="$PI_NGINX_AVAILABLE"
if [ -e "$PI_NGINX_ENABLED" ]; then
  # Some older installs copied the vhost instead of creating a symlink. Patch
  # the file nginx actually loads, then keep sites-available in sync.
  PI_NGINX_CONF="$(readlink -f "$PI_NGINX_ENABLED")"
fi
if command -v nginx >/dev/null \
  && [ -f "$PI_NGINX_CONF" ] \
  && grep -q 'listen 127.0.0.1:8080' "$PI_NGINX_CONF"; then
  echo "== Cloudflare Tunnel + nginx: добавляю /account/ в существующий vhost"
  install -d -m 0700 "$PI_NGINX_BACKUP_DIR"
  cp -a "$PI_NGINX_CONF" "$PI_NGINX_ACTIVE_BACKUP"
  if [ -f "$PI_NGINX_AVAILABLE" ] \
    && [ "$(readlink -f "$PI_NGINX_AVAILABLE")" != "$PI_NGINX_CONF" ]; then
    cp -a "$PI_NGINX_AVAILABLE" "$PI_NGINX_AVAILABLE_BACKUP"
  fi
  python3 - "$PI_NGINX_CONF" "$ACCOUNT_PORT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
port = int(sys.argv[2])
text = path.read_text(encoding="utf-8")
begin = "    # BEGIN SKILLCUE ACCOUNT\n"
end = "    # END SKILLCUE ACCOUNT\n"
if begin in text:
    prefix, rest = text.split(begin, 1)
    if end not in rest:
        raise SystemExit("broken existing SkillCue account route marker")
    text = prefix + rest.split(end, 1)[1]
needle = "    location / {\n"
if needle not in text:
    raise SystemExit("SkillCue nginx fallback location not found")
block = f"""{begin}    location /account/billing/webhooks/ {{
        proxy_pass http://127.0.0.1:{port}/billing/webhooks/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }}

    location /account/ {{
        proxy_pass http://127.0.0.1:{port}/;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }}
{end}
"""
path.write_text(text.replace(needle, block + needle, 1), encoding="utf-8")
PY
  if [ -f "$PI_NGINX_AVAILABLE" ] \
    && [ "$(readlink -f "$PI_NGINX_AVAILABLE")" != "$PI_NGINX_CONF" ]; then
    cp -a "$PI_NGINX_CONF" "$PI_NGINX_AVAILABLE"
  fi
  install -d -m 0755 /var/www/skillcue
  cp -a "$APP_DIR/landing/." /var/www/skillcue/
  if ! nginx -t; then
    cp -a "$PI_NGINX_ACTIVE_BACKUP" "$PI_NGINX_CONF"
    if [ -f "$PI_NGINX_AVAILABLE_BACKUP" ]; then
      cp -a "$PI_NGINX_AVAILABLE_BACKUP" "$PI_NGINX_AVAILABLE"
    fi
    nginx -t
    echo "!! nginx-конфигурация не прошла проверку; восстановлена резервная копия"
    exit 1
  fi
  systemctl reload nginx
  curl -fsS "http://127.0.0.1:${ACCOUNT_PORT}/health" >/dev/null
  curl -fsS -H "Host: $DOMAIN" "http://127.0.0.1:8080/account/health" \
    | grep -F '"service":"skillcue-account"' >/dev/null
  echo "== account API опубликован через Cloudflare Tunnel origin"
  exit 0
fi

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
