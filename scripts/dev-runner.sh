#!/usr/bin/env bash
set -euo pipefail

# Build, deploy, and manage a dev runner on a metal host via Cloudflare Tunnel.
#
# Reads RUNNER_LOCAL_HOST, RUNNER_DEFAULT_GROUP, and OFFICIAL_RUNNER_SECRET
# from scripts/.env.local. Uses scripts/cf-ssh.sh for all remote operations.
#
# Usage:
#   scripts/dev-runner.sh deploy   Build, upload, and start the runner
#   scripts/dev-runner.sh remove   Stop and uninstall the runner

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CRATES_DIR="$PROJECT_ROOT/crates"

log() { echo "[runner] $1" >&2; }

shell_env_assignments() {
  local output=""
  local name
  local value

  while (($#)); do
    name="$1"
    value="${2-}"
    shift 2

    value=${value//\'/\'\\\'\'}
    output+="$name='$value' "
  done

  printf "%s" "${output% }"
}

# --- Load config ---
ENV_FILE="$SCRIPT_DIR/.env.local"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Error: $ENV_FILE not found. Run scripts/sync-env.sh first."
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

HOST="${RUNNER_LOCAL_HOST:?RUNNER_LOCAL_HOST not set in $ENV_FILE}"
SSH_USER="${RUNNER_LOCAL_USER:-ubuntu}"

# --- Runner name from RUNNER_DEFAULT_GROUP ---
RUNNER_GROUP="${RUNNER_DEFAULT_GROUP:?RUNNER_DEFAULT_GROUP not set in $ENV_FILE}"
# vm0/local-alice-macbook -> alice-macbook
RUNNER_NAME="${RUNNER_GROUP##*/}"

REMOTE_BIN_DIR="/var/lib/vm0-runner/bin/${RUNNER_NAME}"
RUNNER_BIN="sudo $REMOTE_BIN_DIR/runner"
RUNNER_DIR="/var/lib/vm0-runner/runners/$RUNNER_NAME"

CF_SSH="$SCRIPT_DIR/cf-ssh.sh"
SSH_KEY="$PROJECT_ROOT/.certs/vm0-metal-local.pem"
if [[ ! -f "$SSH_KEY" ]]; then
  log "Error: SSH key not found at $SSH_KEY"
  log "Run 'scripts/sync-env.sh' to provision it from 1Password."
  exit 1
fi
ssh_cmd() { "$CF_SSH" "$HOST" -l "$SSH_USER" -i "$SSH_KEY" "$@"; }

# --- Commands ---

cmd_deploy() {
  RUNNER_SECRET="${OFFICIAL_RUNNER_SECRET:?OFFICIAL_RUNNER_SECRET not set in $ENV_FILE}"
  TARGET="aarch64-unknown-linux-musl"
  # alice-macbook -> https://tunnel-alice-macbook-www.vm7.ai
  API_URL="https://tunnel-${RUNNER_NAME#local-}-www.vm7.ai"
  log "Runner: $RUNNER_NAME (group: $RUNNER_GROUP, api: $API_URL)"

  # Build guests
  log "Building guest binaries..."
  cd "$CRATES_DIR"
  cargo build --profile ci --target "$TARGET" \
    -p guest-agent -p guest-download -p guest-init -p guest-mock-claude -p guest-mock-codex -p guest-reseed -p guest-write-file

  # Build runner
  log "Building runner with embedded guests..."
  GUEST_AGENT_PATH="target/$TARGET/ci/guest-agent" \
  GUEST_DOWNLOAD_PATH="target/$TARGET/ci/guest-download" \
  GUEST_INIT_PATH="target/$TARGET/ci/guest-init" \
  GUEST_MOCK_CLAUDE_PATH="target/$TARGET/ci/guest-mock-claude" \
  GUEST_MOCK_CODEX_PATH="target/$TARGET/ci/guest-mock-codex" \
  GUEST_RESEED_PATH="target/$TARGET/ci/guest-reseed" \
  GUEST_WRITE_FILE_PATH="target/$TARGET/ci/guest-write-file" \
  cargo build --profile ci --target "$TARGET" -p runner

  BINARY="$CRATES_DIR/target/$TARGET/ci/runner"
  log "Binary: $BINARY ($(du -h "$BINARY" | cut -f1))"

  # Stop old service before uploading (avoids "Text file busy").
  # Try --force first (new runner), fall back to no-flag (old runner).
  log "Stopping old service..."
  ssh_cmd "$RUNNER_BIN service stop --name $RUNNER_NAME --force" || ssh_cmd "$RUNNER_BIN service stop --name $RUNNER_NAME" || true

  # Upload
  log "Deploying to $SSH_USER@$HOST..."
  ssh_cmd "sudo mkdir -p $REMOTE_BIN_DIR"
  ssh_cmd "sudo install -m 755 /dev/stdin $REMOTE_BIN_DIR/runner" < "$BINARY"

  # Setup (idempotent, downloads firecracker/kernel if missing)
  log "Running setup..."
  ssh_cmd "$RUNNER_BIN setup"

  # R2 creds passed as sudo args so they survive sudo's env scrub. Empty
  # values are treated as "unset" by r2_cache.rs, matching
  # ansible/playbooks/build-runner.yml's R2 env block. Applied to both
  # `gc` (sweeps shared R2 objects older than 7d) and `build` (pulls
  # cached rootfs instead of rebuilding ~3-5min locally).
  R2_ENV="$(shell_env_assignments \
    R2_ACCOUNT_ID "${R2_ACCOUNT_ID:-}" \
    R2_ACCESS_KEY_ID "${R2_ACCESS_KEY_ID:-}" \
    R2_SECRET_ACCESS_KEY "${R2_SECRET_ACCESS_KEY:-}" \
    R2_USER_STORAGES_BUCKET_NAME "${R2_USER_STORAGES_BUCKET_NAME:-}")"

  # Clean up old images (keep 3 most recent deploys)
  ssh_cmd "sudo $R2_ENV $REMOTE_BIN_DIR/runner gc --keep-latest 3"

  # Build unified image (rootfs + snapshot)
  PROFILES=("vm0/default")
  CONFIG_ARGS=""

  for PROFILE in "${PROFILES[@]}"; do
    log "Building $PROFILE..."
    BUILD_LOG=$(mktemp)
    ssh_cmd "sudo $R2_ENV $REMOTE_BIN_DIR/runner build --profile $PROFILE" | tee "$BUILD_LOG"
    ROOTFS_HASH=$(grep '^rootfs_hash=' "$BUILD_LOG" | cut -d= -f2)
    SNAPSHOT_HASH=$(grep '^snapshot_hash=' "$BUILD_LOG" | cut -d= -f2)
    rm -f "$BUILD_LOG"

    if [[ -z "$ROOTFS_HASH" || -z "$SNAPSHOT_HASH" ]]; then
      log "Error: failed to extract rootfs/snapshot hash for $PROFILE"
      exit 1
    fi
    log "$PROFILE: rootfs=$ROOTFS_HASH snapshot=$SNAPSHOT_HASH"

    CONFIG_ARGS+=" --profile $PROFILE --rootfs-hash $ROOTFS_HASH --snapshot-hash $SNAPSHOT_HASH"
  done

  # Generate config
  log "Generating config..."
  ssh_cmd "$RUNNER_BIN config \
    $CONFIG_ARGS \
    --name $RUNNER_NAME \
    --group $RUNNER_GROUP \
    --runner-dirname $RUNNER_NAME \
    --api-url $API_URL \
    --token vm0_official_${RUNNER_SECRET}"

  # Start service
  log "Starting new service..."
  LOCAL_FLAG=""
  MOCK_FLAG=""
  if [[ "${LOCAL_MODE:-}" == "1" ]]; then
    LOCAL_FLAG="--local"
    MOCK_FLAG="--env USE_MOCK_CLAUDE=true"
  fi
  ssh_cmd "$RUNNER_BIN service start --name $RUNNER_NAME \
    --config $RUNNER_DIR/runner.yaml $LOCAL_FLAG $MOCK_FLAG"

  log "Done! Runner $RUNNER_NAME deployed to $HOST"
}

cmd_submit() {
  PROFILE="${2:?Usage: $0 submit <profile> <prompt>}"
  PROMPT="${3:?Usage: $0 submit <profile> <prompt>}"
  log "Submitting job to $RUNNER_NAME (profile: $PROFILE, prompt: $PROMPT)..."
  # Use printf %q to safely escape the prompt for remote shell
  ESCAPED_PROMPT=$(printf '%q' "$PROMPT")
  ssh_cmd "$RUNNER_BIN local submit --group $RUNNER_GROUP --profile $PROFILE --prompt $ESCAPED_PROMPT --timeout 120"
}

cmd_deploy_local() {
  LOCAL_MODE=1 cmd_deploy
}

cmd_exec() {
  RUN_ID="${2:?Usage: $0 exec <run-id> <command...>}"
  COMMAND="${3:?Usage: $0 exec <run-id> <command...>}"
  shift 3
  COMMAND="$COMMAND $*"
  log "Executing in VM $RUN_ID: $COMMAND"
  ESCAPED_COMMAND=$(printf '%q' "$COMMAND")
  ssh_cmd "$RUNNER_BIN exec $RUN_ID -- $ESCAPED_COMMAND"
}

cmd_remove() {
  log "Removing runner $RUNNER_NAME from $HOST..."

  ssh_cmd "$RUNNER_BIN service stop --name $RUNNER_NAME --force" || ssh_cmd "$RUNNER_BIN service stop --name $RUNNER_NAME" || true
  ssh_cmd "sudo rm -rf $REMOTE_BIN_DIR $RUNNER_DIR"

  log "Done! Runner $RUNNER_NAME removed from $HOST"
}

# --- Main ---
COMMAND="${1:-}"
case "$COMMAND" in
  deploy) cmd_deploy ;;
  deploy-local) cmd_deploy_local ;;
  submit) cmd_submit "$@" ;;
  exec) cmd_exec "$@" ;;
  remove) cmd_remove ;;
  *)
    log "Usage: $0 {deploy|deploy-local|submit|exec|remove}"
    exit 1
    ;;
esac
