#!/bin/sh
set -e

echo "[VM0] Starting initialization..."

# ---------- Docker socket permission fix ----------
# Handles docker.sock mounts across different environments:
#   - Linux native Docker (GID is typically the docker group: 999/998/136 etc.)
#   - macOS Docker Desktop (socket is usually root:root 0660)
#   - macOS OrbStack (similar to Docker Desktop)
#   - Windows Docker Desktop / WSL (GID depends on the WSL distro)
#
# Strategy: read the actual GID of docker.sock and ensure the nextjs user
# belongs to that group.

DOCKER_SOCK="${DOCKER_HOST:-/var/run/docker.sock}"
# Strip unix:// prefix if present
DOCKER_SOCK="${DOCKER_SOCK#unix://}"

if [ -S "$DOCKER_SOCK" ]; then
  SOCK_GID=$(stat -c '%g' "$DOCKER_SOCK" 2>/dev/null || stat -f '%g' "$DOCKER_SOCK" 2>/dev/null)
  if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
    # Check if a group with this GID already exists
    EXISTING_GROUP=$(getent group "$SOCK_GID" 2>/dev/null | cut -d: -f1 || true)
    if [ -z "$EXISTING_GROUP" ]; then
      addgroup --system --gid "$SOCK_GID" dockersock
      EXISTING_GROUP="dockersock"
    fi
    addgroup nextjs "$EXISTING_GROUP" 2>/dev/null || true
    echo "[VM0] Docker socket permission fixed (GID=$SOCK_GID)"
  elif [ "$SOCK_GID" = "0" ]; then
    # GID is 0 (root group) - chmod so nextjs can access it
    chmod 0666 "$DOCKER_SOCK" 2>/dev/null || true
    echo "[VM0] Docker socket permission fixed (GID=0, chmod 0666)"
  fi
else
  echo "[VM0] Docker socket not found ($DOCKER_SOCK), skipping permission fix"
fi

# ---------- All subsequent operations run as nextjs user ----------

# 1. Wait for database (max 60 seconds)
echo "[VM0] Waiting for database..."
DB_RETRIES=0
DB_MAX_RETRIES=60
until su-exec nextjs nc -z postgres 5432 2>/dev/null; do
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
    chown nextjs:nodejs "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "[VM0] Generated and saved new encryption key"
  fi
fi

# 3. Run database migrations
echo "[VM0] Running database migrations..."
cd /app/apps/web
su-exec nextjs tsx scripts/migrate.ts
cd /app
echo "[VM0] Migrations complete"

# 4. Initialize self-hosted data (default user, scope)
echo "[VM0] Running self-hosted initialization..."
cd /app/apps/web
su-exec nextjs tsx scripts/self-hosted-init.ts
cd /app
echo "[VM0] Initialization complete"

# 5. Start application as nextjs user
echo "[VM0] Starting web server..."
exec su-exec nextjs node apps/web/server.js
