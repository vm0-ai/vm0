#!/bin/sh
set -e

echo "[VM0] Starting initialization..."

# 1. Wait for database (max 60 attempts = ~60 seconds)
echo "[VM0] Waiting for database..."
DB_RETRIES=0
DB_MAX_RETRIES=60
until nc -z postgres 5432 2>/dev/null; do
  DB_RETRIES=$((DB_RETRIES + 1))
  if [ "$DB_RETRIES" -ge "$DB_MAX_RETRIES" ]; then
    echo "[VM0] ERROR: Database not reachable after ${DB_MAX_RETRIES}s, aborting"
    exit 1
  fi
  sleep 1
done
echo "[VM0] Database is ready"

# 2. Auto-generate SECRETS_ENCRYPTION_KEY if not provided
KEY_FILE="/app/data/encryption.key"
if [ -z "$SECRETS_ENCRYPTION_KEY" ]; then
  if [ -f "$KEY_FILE" ]; then
    export SECRETS_ENCRYPTION_KEY=$(cat "$KEY_FILE")
    echo "[VM0] Loaded encryption key from persistent storage"
  else
    export SECRETS_ENCRYPTION_KEY=$(openssl rand -hex 32)
    mkdir -p /app/data
    echo "$SECRETS_ENCRYPTION_KEY" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "[VM0] Generated and saved new encryption key"
  fi
fi

# 3. Run database migrations
echo "[VM0] Running database migrations..."
cd /app/apps/web
DATABASE_URL="$DATABASE_URL" tsx scripts/migrate.ts
cd /app
echo "[VM0] Migrations complete"

# 4. Initialize self-hosted data (default user, scope)
echo "[VM0] Running self-hosted initialization..."
cd /app/apps/web
DATABASE_URL="$DATABASE_URL" tsx scripts/self-hosted-init.ts
cd /app
echo "[VM0] Initialization complete"

# 5. Start application
echo "[VM0] Starting web server..."
exec node apps/web/server.js
