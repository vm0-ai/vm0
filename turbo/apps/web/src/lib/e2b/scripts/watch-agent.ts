/**
 * Agent event watcher script
 * Watches /var/log/vm0/agent.jsonl and streams events in real-time
 * to the events webhook endpoint
 */
export const WATCH_AGENT_SCRIPT = `#!/bin/bash
# Agent event watcher - streams events in real-time to webhook

LOG_SCRIPT_NAME="watch-agent"
SCRIPT_DIR="$(dirname "$0")"
source "\${SCRIPT_DIR}/common.sh"
source "\${SCRIPT_DIR}/log.sh"
source "\${SCRIPT_DIR}/request.sh"
source "\${SCRIPT_DIR}/send-event.sh"

# Log files
LOG_DIR="/var/log/vm0"
AGENT_FILE="\${LOG_DIR}/agent.jsonl"

log_info "Starting agent event watcher"

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

# Watch and stream events
watch_agent_events() {
  if ! wait_for_file "$AGENT_FILE"; then
    log_error "Agent file not created, exiting"
    return 1
  fi

  log_info "Watching agent events from $AGENT_FILE"

  # Use tail -f -n +1 to read from beginning and follow new content
  # This ensures we don't miss events written before tail starts
  tail -f -n +1 "$AGENT_FILE" 2>/dev/null | while IFS= read -r line; do
    # Skip empty lines
    if [ -z "$line" ]; then
      continue
    fi

    # Validate JSON and send event
    if echo "$line" | jq empty 2>/dev/null; then
      send_event "$line"

      # Extract result from "result" event for stdout
      event_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
      if [ "$event_type" = "result" ]; then
        result_content=$(echo "$line" | jq -r '.result // empty' 2>/dev/null)
        if [ -n "$result_content" ]; then
          echo "$result_content"
        fi
      fi
    else
      log_warn "Invalid JSON line: $line"
    fi
  done
}

# Run watcher
watch_agent_events
`;
