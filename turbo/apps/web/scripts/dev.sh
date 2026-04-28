#!/bin/bash
# Start Cloudflare Tunnel, Stripe webhook forwarding, and Next.js dev server
#
# This script enables external webhooks to reach localhost by:
# 1. Starting a Cloudflare Tunnel via scripts/tunnel.sh
# 2. Starting Stripe CLI webhook forwarding (if STRIPE_SECRET_KEY is set)
# 3. Executing Next.js dev server with VM0_API_URL set to tunnel URL
#
# Related: https://github.com/vm0-ai/vm0/issues/1726

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PORT=3000
ENV_LOCAL_FILE="$WEB_APP_DIR/.env.local"

# Kill stale background processes from prior runs that may have been orphaned
# (e.g. previous run SIGKILLed, container stopped, or trap didn't fire).
kill_stale() {
  local pidfile="$1" pattern="$2"
  local pid
  pid=$(cat "$pidfile" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  if [[ -n "$pattern" ]]; then
    pkill -f "$pattern" 2>/dev/null || true
  fi
}

kill_stale "/tmp/cloudflared-${PORT}.pid" "cloudflared tunnel .*localhost:${PORT}"
kill_stale "/tmp/stripe-listen.pid" "stripe listen .*--forward-to localhost:${PORT}/api/webhooks/stripe"

# Swap apps/web/node_modules/next to the next-fast-dev alias (next@16.1.7) so
# `next dev --turbo` avoids the ~4× cpu/cold-build regression introduced in
# next 16.2.0+. The dependency name is "next-fast-dev" but it resolves to
# next@16.1.7 via npm: alias. Production `next build` is unaffected — it still
# uses the real `next` entry (16.2.3+, which carries the CVE-2026-23869 fix).
#
# We can't rely on a trap for cleanup because the script ends with `exec next
# dev …` and the bash process is replaced before any exit handler can fire.
# Instead, the original target is recorded in a side file and restored on the
# *next* launch — same idempotent-stale-cleanup pattern that cloudflared and
# stripe use above.
SCRIPT_DIR_FOR_LINK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEXT_LINK="$(cd "$SCRIPT_DIR_FOR_LINK/.." && pwd)/node_modules/next"
NEXT_FAST_LINK="$(cd "$SCRIPT_DIR_FOR_LINK/.." && pwd)/node_modules/next-fast-dev"
NEXT_LINK_ORIG_FILE="/tmp/web-next-link-orig.path"

# Pre-launch: if a previous run left the link pointing at the alias, restore
# it before swapping again so we capture a clean original.
if [[ -L "$NEXT_LINK" && -L "$NEXT_FAST_LINK" ]] \
   && [[ "$(readlink "$NEXT_LINK")" == "$(readlink "$NEXT_FAST_LINK")" ]] \
   && [[ -f "$NEXT_LINK_ORIG_FILE" ]]; then
  ln -sfn "$(cat "$NEXT_LINK_ORIG_FILE")" "$NEXT_LINK"
  rm -f "$NEXT_LINK_ORIG_FILE"
fi

# Now perform the swap. Record the original so the *next* invocation can
# undo it.
if [[ -L "$NEXT_FAST_LINK" && -L "$NEXT_LINK" ]]; then
  NEXT_LINK_ORIG="$(readlink "$NEXT_LINK")"
  NEXT_FAST_TARGET="$(readlink "$NEXT_FAST_LINK")"
  if [[ "$NEXT_LINK_ORIG" != "$NEXT_FAST_TARGET" ]]; then
    echo "$NEXT_LINK_ORIG" > "$NEXT_LINK_ORIG_FILE"
    ln -sfn "$NEXT_FAST_TARGET" "$NEXT_LINK"
    echo -e "\033[0;36m[next-fast-dev]\033[0m using next@16.1.7 for dev (avoids 16.2.x turbopack cpu regression)"
  fi
fi

# Cleanup background processes on exit
cleanup() {
  kill_stale "/tmp/cloudflared-${PORT}.pid" ""
  kill_stale "/tmp/stripe-listen.pid" ""
}
trap cleanup EXIT INT TERM

# Start tunnel and capture URL (TUNNEL_HOSTNAME is forwarded if set)
TUNNEL_URL=$("$REPO_ROOT/scripts/tunnel.sh" "$PORT")

echo ""
echo -e "\033[0;32m[tunnel]\033[0m Tunnel URL: ${TUNNEL_URL}"
echo -e "\033[0;32m[tunnel]\033[0m Webhooks: \033[1;33m${TUNNEL_URL}/api/webhooks/agent-events\033[0m"
echo ""

# Start Stripe CLI webhook forwarding
STRIPE_KEY=$(grep "^STRIPE_SECRET_KEY=" "$ENV_LOCAL_FILE" | cut -d= -f2)
if [[ -z "$STRIPE_KEY" ]]; then
  echo "Error: STRIPE_SECRET_KEY not found in .env.local. Run scripts/sync-env.sh first." >&2
  exit 1
fi

STRIPE_WHSEC=$(stripe listen --api-key "$STRIPE_KEY" --print-secret 2>/dev/null)
sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=${STRIPE_WHSEC}|" "$ENV_LOCAL_FILE"

stripe listen \
  --api-key "$STRIPE_KEY" \
  --forward-to "localhost:${PORT}/api/webhooks/stripe" \
  > /tmp/stripe-listen.log 2>&1 &
echo "$!" > /tmp/stripe-listen.pid

echo -e "\033[0;35m[stripe]\033[0m Webhook forwarding → localhost:${PORT}/api/webhooks/stripe"

# Start Next.js dev server
cd "$WEB_APP_DIR"
exec env VM0_API_URL="$TUNNEL_URL" npx next dev --turbo --port "$PORT"
