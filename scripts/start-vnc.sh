#!/bin/bash
# Start the noVNC stack (Xvfb + openbox + x11vnc + websockify) and launch Chrome.
#
# The script stays in the foreground. Ctrl-C (or SIGTERM) cleanly shuts down
# all child processes. This makes it safe to run via `run_in_background` in
# Claude Code — when the task is stopped the whole VNC stack goes away.
#
# If CF_ACCESS_TOKEN is set, also creates a Cloudflare Tunnel with Access
# protection (only your email can access). Otherwise, noVNC is local-only
# (use `dcvnc <vm>` to open it from the host).
#
# Outputs the access URL to stdout. All other messages go to stderr.
#
# Usage: scripts/start-vnc.sh
#
# Environment:
#   DISPLAY          - X display number (default: :99)
#   VNC_PORT         - VNC server port (default: 5900)
#   NOVNC_PORT       - noVNC websocket port (default: 6080)
#   SCREEN_RES       - Screen resolution (default: 1344x840x24)
#   CF_ACCESS_TOKEN  - Cloudflare API token with Access:Edit permission (optional)
#   TUNNEL_HOSTNAME  - Override tunnel domain (optional)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DISPLAY="${DISPLAY:-:99}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
SCREEN_RES="${SCREEN_RES:-1344x840x24}"

log() { echo -e "[vnc] $1" >&2; }

# Track child PIDs for cleanup
PIDS=()

cleanup() {
  log "Shutting down VNC stack..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Also kill any Chrome we started (matched by CDP port)
  pkill -f "chrome.*--remote-debugging-port=${CDP_PORT:-9222}" 2>/dev/null || true
  wait 2>/dev/null || true
  log "All processes stopped."
}

trap cleanup EXIT INT TERM

# --- Install dependencies if missing ---
MISSING=()
command -v x11vnc >/dev/null 2>&1 || MISSING+=(x11vnc)
command -v Xvfb >/dev/null 2>&1 || MISSING+=(xvfb)
command -v openbox >/dev/null 2>&1 || MISSING+=(openbox)
command -v websockify >/dev/null 2>&1 || MISSING+=(novnc)

if [[ ${#MISSING[@]} -gt 0 ]]; then
  log "Installing missing packages: ${MISSING[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${MISSING[@]}"
fi

# --- Kill any leftover processes from previous runs ---
pkill -x Xvfb 2>/dev/null || true
pkill -x openbox 2>/dev/null || true
pkill -x x11vnc 2>/dev/null || true
pkill -f websockify 2>/dev/null || true
pkill -f "chrome.*--remote-debugging-port=${CDP_PORT:-9222}" 2>/dev/null || true
sleep 1

# --- Start Xvfb ---
log "Starting Xvfb on ${DISPLAY} (${SCREEN_RES})"
Xvfb "$DISPLAY" -screen 0 "$SCREEN_RES" >/dev/null 2>&1 &
PIDS+=($!)
sleep 1

# --- Start openbox (window manager) ---
log "Starting openbox"
DISPLAY="$DISPLAY" openbox >/dev/null 2>&1 &
PIDS+=($!)
sleep 1

# --- Start x11vnc ---
log "Starting x11vnc on port ${VNC_PORT}"
x11vnc -display "$DISPLAY" -nopw -forever -shared -rfbport "$VNC_PORT" >/dev/null 2>&1 &
PIDS+=($!)
sleep 1

# --- Start websockify (noVNC) ---
log "Starting websockify on 0.0.0.0:${NOVNC_PORT} -> localhost:${VNC_PORT}"
websockify --web /usr/share/novnc/ "0.0.0.0:${NOVNC_PORT}" "localhost:${VNC_PORT}" >/dev/null 2>&1 &
PIDS+=($!)
sleep 1

# --- Launch Chrome with CDP (remote debugging) ---
CDP_PORT="${CDP_PORT:-9222}"
CHROME_BIN=$(find "$HOME/.cache/ms-playwright" -name chrome -type f 2>/dev/null | head -1)
CHROME_PROFILE="${AGENT_BROWSER_PROFILE:-$HOME/.local/share/agent-browser/profile}"

if [[ -z "$CHROME_BIN" ]]; then
  log "Warning: Chrome not found in Playwright cache, skipping"
else
  # Clear stale profile locks from other VMs
  rm -f "${CHROME_PROFILE}/SingletonLock" "${CHROME_PROFILE}/SingletonCookie" "${CHROME_PROFILE}/SingletonSocket" 2>/dev/null
  log "Starting Chrome (profile: ${CHROME_PROFILE}, CDP port: ${CDP_PORT})"
  DISPLAY="$DISPLAY" "$CHROME_BIN" \
    --user-data-dir="$CHROME_PROFILE" \
    --remote-debugging-port="$CDP_PORT" \
    --no-first-run \
    --no-default-browser-check \
    --disable-blink-features=AutomationControlled \
    --start-maximized \
    >/dev/null 2>&1 &
  PIDS+=($!)
  sleep 2
fi

# --- Verify VNC stack ---
if ! pgrep -x Xvfb >/dev/null; then
  log "Error: Xvfb failed to start"
  exit 1
fi
if ! pgrep -f websockify >/dev/null; then
  log "Error: websockify failed to start"
  exit 1
fi

log "noVNC stack ready — local viewer at http://localhost:${NOVNC_PORT}/vnc.html"

# --- Cloudflare Tunnel + Access (only when CF_ACCESS_TOKEN is set) ---
if [[ -n "${CF_ACCESS_TOKEN:-}" ]]; then
  if [[ -z "${TUNNEL_HOSTNAME:-}" ]]; then
    EMAIL=$(git config user.email 2>/dev/null || true)
    DOMAIN="${EMAIL##*@}"
    if [[ "$DOMAIN" == "vm0.ai" ]]; then
      USERNAME="${EMAIL%%@*}"
      TUNNEL_HOSTNAME="${USERNAME}-$(hostname).vnc.vm7.ai"
    fi
  fi

  TUNNEL_PIDFILE="/tmp/cloudflared-${NOVNC_PORT}.pid"
  if [[ -f "$TUNNEL_PIDFILE" ]] && kill -0 "$(cat "$TUNNEL_PIDFILE")" 2>/dev/null; then
    TUNNEL_URL="https://${TUNNEL_HOSTNAME:-localhost:${NOVNC_PORT}}"
    log "Cloudflare Tunnel already running (pid: $(cat "$TUNNEL_PIDFILE"))"
  else
    log "Starting Cloudflare Tunnel for port ${NOVNC_PORT}..."
    TUNNEL_URL=$(TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-}" "${SCRIPT_DIR}/tunnel.sh" "$NOVNC_PORT")
  fi

  if [[ -n "${TUNNEL_HOSTNAME:-}" ]]; then
    "${SCRIPT_DIR}/tunnel-access.sh" "$TUNNEL_HOSTNAME"
  fi

  log "noVNC available at: ${TUNNEL_URL}/vnc.html"
  echo "$TUNNEL_URL"
else
  log "No CF_ACCESS_TOKEN set — skipping tunnel (local-only mode)"
  log "Use 'dcvnc $(hostname)' from the host to open noVNC"
  echo "http://localhost:${NOVNC_PORT}"
fi

# --- Stay in foreground until signalled ---
log "Press Ctrl-C to stop."
wait
