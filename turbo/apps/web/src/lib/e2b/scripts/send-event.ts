/**
 * Event sending script for agent execution
 * Sends JSONL events to the webhook endpoint
 */
export const SEND_EVENT_SCRIPT = `# Send single event immediately
# Requires: COMMON_SCRIPT, LOG_SCRIPT, REQUEST_SCRIPT to be sourced first

send_event() {
  local event_json="$1"

  # Extract session ID from init event
  local event_type=$(echo "$event_json" | jq -r '.type // empty' 2>/dev/null)
  local event_subtype=$(echo "$event_json" | jq -r '.subtype // empty' 2>/dev/null)
  if [ "$event_type" = "system" ] && [ "$event_subtype" = "init" ] && [ ! -f "$SESSION_ID_FILE" ]; then
    local session_id=$(echo "$event_json" | jq -r '.session_id // empty' 2>/dev/null)
    if [ -n "$session_id" ]; then
      log_info "Captured session ID: $session_id"
      # Save to temp file to persist across subshells
      echo "$session_id" > "$SESSION_ID_FILE"
      # Calculate session history path
      # Claude Code uses hyphen-separated path encoding (e.g., /home/user/workspace -> -home-user-workspace)
      local project_name=$(echo "$WORKING_DIR" | sed 's|^/||' | sed 's|/|-|g')
      local session_history_path="$HOME/.config/claude/projects/-\${project_name}/\${session_id}.jsonl"
      echo "$session_history_path" > "$SESSION_HISTORY_PATH_FILE"
      log_info "Session history will be at: $session_history_path"
    fi
  fi

  local payload=$(jq -n \\
    --arg rid "$RUN_ID" \\
    --argjson event "$event_json" \\
    '{runId: $rid, events: [$event]}')

  # Send event using unified HTTP request function
  if ! http_post_json "$WEBHOOK_URL" "$payload" >/dev/null; then
    log_error "Failed to send event after retries"
    # Mark that event sending failed - run-agent.sh will check this
    touch "$EVENT_ERROR_FLAG"
    return 1
  fi

  return 0
}
`;
