#!/bin/bash
# vnc-resize-helper.sh — Watch x11vnc log for client resize requests and apply them via xrandr
#
# x11vnc logs "Client requested resolution change to (WxH)" but cannot
# call xrandr itself. This helper watches the log and does it instead.

set -eu

LOG_FILE="${1:-/tmp/x11vnc-debug.log}"
DISPLAY="${DISPLAY:-:99}"
export DISPLAY

LAST_APPLIED=""

tail -n 0 -F "$LOG_FILE" 2>/dev/null | while read -r line; do
  if [[ "$line" =~ "Client requested resolution change to ("([0-9]+)x([0-9]+)")" ]]; then
    W="${BASH_REMATCH[1]}"
    H="${BASH_REMATCH[2]}"
    MODE="${W}x${H}"

    # Skip if we just applied this
    [[ "$MODE" == "$LAST_APPLIED" ]] && continue

    # Create mode if it doesn't exist
    if ! xrandr | grep -q "^   ${MODE} "; then
      xrandr --newmode "$MODE" 0 "$W" "$W" "$W" "$W" "$H" "$H" "$H" "$H" 2>/dev/null || true
      xrandr --addmode screen "$MODE" 2>/dev/null || true
    fi

    # Switch to it
    if xrandr -s "$MODE" 2>/dev/null; then
      LAST_APPLIED="$MODE"
      echo "[vnc-resize] Applied ${MODE}"
    else
      echo "[vnc-resize] Failed to apply ${MODE}" >&2
    fi
  fi
done
