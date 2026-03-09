#!/bin/bash
# Start the noVNC stack (Xvfb + openbox + x11vnc + websockify), launch Chrome,
# and expose noVNC to the public internet via a Cloudflare Tunnel.
#
# Outputs the tunnel URL to stdout. All other messages go to stderr.
# Idempotent — safe to call multiple times; skips already-running processes.
#
# For @vm0.ai users, creates a named tunnel at <username>-<hostname>.vnc.vm7.ai
# (e.g., ethan-vm04.vnc.vm7.ai). Otherwise, creates an anonymous tunnel.
#
# Usage: scripts/start-vnc.sh
#
# Environment:
#   DISPLAY          - X display number (default: :99)
#   VNC_PORT         - VNC server port (default: 5900)
#   NOVNC_PORT       - noVNC websocket port (default: 6080)
#   SCREEN_RES       - Screen resolution (default: 1344x840x24)
#   TUNNEL_HOSTNAME  - Override tunnel domain (optional)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

DISPLAY="${DISPLAY:-:99}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
SCREEN_RES="${SCREEN_RES:-1344x840x24}"

log() { echo -e "[vnc] $1" >&2; }

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

# --- Start Xvfb ---
if pgrep -x Xvfb >/dev/null; then
  log "Xvfb already running"
else
  log "Starting Xvfb on ${DISPLAY} (${SCREEN_RES})"
  Xvfb "$DISPLAY" -screen 0 "$SCREEN_RES" >/dev/null 2>&1 &
  sleep 1
fi

# --- Start openbox (window manager) ---
if pgrep -x openbox >/dev/null; then
  log "openbox already running"
else
  log "Starting openbox"
  DISPLAY="$DISPLAY" openbox >/dev/null 2>&1 &
  sleep 1
fi

# --- Start x11vnc ---
if pgrep -x x11vnc >/dev/null; then
  log "x11vnc already running"
else
  log "Starting x11vnc on port ${VNC_PORT}"
  x11vnc -display "$DISPLAY" -nopw -forever -shared -rfbport "$VNC_PORT" >/dev/null 2>&1 &
  sleep 1
fi

# --- Start websockify (noVNC) ---
if pgrep -f websockify >/dev/null; then
  log "websockify already running"
else
  log "Starting websockify on 0.0.0.0:${NOVNC_PORT} -> localhost:${VNC_PORT}"
  websockify --web /usr/share/novnc/ "0.0.0.0:${NOVNC_PORT}" "localhost:${VNC_PORT}" >/dev/null 2>&1 &
  sleep 1
fi

# --- Launch Chrome with CDP (remote debugging) ---
# Chrome is started with --remote-debugging-port so that agent-browser can
# connect to the same instance via --cdp. This ensures the user watching
# noVNC and the agent share the exact same browser.
CDP_PORT="${CDP_PORT:-9222}"
CHROME_BIN=$(find "$HOME/.cache/ms-playwright" -name chrome -type f 2>/dev/null | head -1)
CHROME_PROFILE="${AGENT_BROWSER_PROFILE:-$HOME/.local/share/agent-browser/profile}"

if [[ -z "$CHROME_BIN" ]]; then
  log "Warning: Chrome not found in Playwright cache, skipping"
elif pgrep -f "chrome.*--remote-debugging-port=${CDP_PORT}" >/dev/null 2>&1; then
  log "Chrome already running (CDP port ${CDP_PORT})"
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

# --- Compute tunnel hostname for VNC ---
# Format: <username>-<hostname>.vnc.vm7.ai (e.g., ethan-vm04.vnc.vm7.ai)
# Requires Advanced Certificate Manager for *.vnc.vm7.ai SSL coverage.
if [[ -z "${TUNNEL_HOSTNAME:-}" ]]; then
  EMAIL=$(git config user.email 2>/dev/null || true)
  DOMAIN="${EMAIL##*@}"
  if [[ "$DOMAIN" == "vm0.ai" ]]; then
    USERNAME="${EMAIL%%@*}"
    TUNNEL_HOSTNAME="${USERNAME}-$(hostname).vnc.vm7.ai"
  fi
fi

# --- Start Cloudflare Tunnel (idempotent) ---
TUNNEL_PIDFILE="/tmp/cloudflared-${NOVNC_PORT}.pid"
if [[ -f "$TUNNEL_PIDFILE" ]] && kill -0 "$(cat "$TUNNEL_PIDFILE")" 2>/dev/null; then
  TUNNEL_URL="https://${TUNNEL_HOSTNAME:-localhost:${NOVNC_PORT}}"
  log "Cloudflare Tunnel already running (pid: $(cat "$TUNNEL_PIDFILE"))"
else
  log "Starting Cloudflare Tunnel for port ${NOVNC_PORT}..."
  TUNNEL_URL=$(TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-}" "${SCRIPT_DIR}/tunnel.sh" "$NOVNC_PORT")
fi

log "noVNC available at: ${TUNNEL_URL}/vnc.html"

# Output tunnel URL to stdout (same convention as tunnel.sh)
echo "$TUNNEL_URL"
