#!/bin/bash
# Dev server health check: verify SSL certs and port accessibility

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$PROJECT_ROOT" ]; then
  echo "Error: Not in a git repository" >&2
  exit 1
fi

# --- Port check ---
check_port() {
  local label="$1"
  local url="$2"
  if curl -k -s --connect-timeout 3 --resolve "$(echo "$url" | sed 's|https://||;s|/.*||'):127.0.0.1" "$url" > /dev/null 2>&1; then
    echo "$label | running"
  else
    echo "$label | not started"
  fi
}

check_port "Web:      https://www.vm7.ai:8443"      "https://www.vm7.ai:8443/"
check_port "App:      https://app.vm7.ai:8443"  "https://app.vm7.ai:8443/"
check_port "API:      https://api.vm7.ai:8443"  "https://api.vm7.ai:8443/health"
