/**
 * Agent event watcher script
 * Watches /var/log/vm0/agent.jsonl for monitoring purposes
 * Note: Events are sent by run-agent.sh directly for reliability
 * This watcher is kept for potential future use (e.g., monitoring, debugging)
 */
export const WATCH_AGENT_SCRIPT = `#!/bin/bash
# Agent event watcher - monitors agent log file
# Note: Event sending is handled by run-agent.sh directly

LOG_SCRIPT_NAME="watch-agent"
SCRIPT_DIR="$(dirname "$0")"
source "\${SCRIPT_DIR}/common.sh"
source "\${SCRIPT_DIR}/log.sh"

# Log files
LOG_DIR="/var/log/vm0"
AGENT_FILE="\${LOG_DIR}/agent.jsonl"

log_info "Starting agent event watcher (monitoring only)"

# Wait for agent file to be created
wait_for_file() {
  local file="$1"
  local timeout=60
  local elapsed=0

  while [ ! -f "$file" ] && [ $elapsed -lt $timeout ]; do
    sleep 0.5
    elapsed=$((elapsed + 1))
  done

  if [ ! -f "$file" ]; then
    log_error "Timeout waiting for $file"
    return 1
  fi

  return 0
}

# Watch agent events (monitoring only, no sending)
watch_agent_events() {
  if ! wait_for_file "$AGENT_FILE"; then
    log_error "Agent file not created, exiting"
    return 1
  fi

  log_info "Watching agent events from $AGENT_FILE"

  # Use tail -f -n +1 to read from beginning and follow new content
  tail -f -n +1 "$AGENT_FILE" 2>/dev/null | while IFS= read -r line; do
    # Skip empty lines
    if [ -z "$line" ]; then
      continue
    fi

    # Validate JSON and log for monitoring
    if echo "$line" | jq empty 2>/dev/null; then
      event_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
      log_debug "Event: $event_type"
    fi
  done
}

# Run watcher
watch_agent_events
`;
