#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/skillcue}"
ACCOUNT_ENV="$APP_DIR/account.env"

log() { echo "== $*"; }
test -f "$ACCOUNT_ENV" || { echo "!! account.env not found"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
log "PostgreSQL and account runtime"
apt-get update -qq
apt-get install -y -qq postgresql ca-certificates >/dev/null
systemctl enable --now postgresql

DB_PASSWORD="$(grep -oP '(?<=^PG_ACCOUNT_PASSWORD=).*' "$ACCOUNT_ENV")"
[[ "$DB_PASSWORD" =~ ^[A-Za-z0-9_-]{32,}$ ]] || { echo "!! unsafe database password format"; exit 1; }

if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='skillcue_account'" | grep -q 1; then
  runuser -u postgres -- psql -c "CREATE ROLE skillcue_account LOGIN PASSWORD '$DB_PASSWORD'"
else
  runuser -u postgres -- psql -c "ALTER ROLE skillcue_account PASSWORD '$DB_PASSWORD'"
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='skillcue_account'" | grep -q 1; then
  runuser -u postgres -- createdb -O skillcue_account skillcue_account
fi

id -u skillcue >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin skillcue

cd "$APP_DIR"
log "install dependencies and build isolated account API"
pnpm install --no-frozen-lockfile
pnpm --filter @interview/shared build
pnpm --filter @interview/api db:generate
pnpm --filter @interview/api exec tsc -p tsconfig.account.json

DATABASE_URL="$(grep -oP '(?<=^DATABASE_URL=).*' "$ACCOUNT_ENV")" \
  pnpm --filter @interview/api exec prisma migrate deploy

install -m 0644 "$APP_DIR/apps/api/deploy/skillcue-account.service" /etc/systemd/system/skillcue-account.service
systemctl daemon-reload
systemctl enable --now skillcue-account
systemctl restart skillcue-account

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8788/health >/dev/null; then
    log "account API OK"
    exit 0
  fi
  sleep 1
done

journalctl -u skillcue-account --no-pager -n 80
echo "!! account API health check failed"
exit 1
