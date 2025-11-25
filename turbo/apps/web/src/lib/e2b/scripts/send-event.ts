/**
 * Event sending script for agent execution
 * Sends JSONL events to the webhook endpoint
 */
export const SEND_EVENT_SCRIPT = `# Send single event immediately
# Requires: COMMON_SCRIPT to be sourced first

send_event() {
  local event_json="$1"

  # Extract session ID from init event
  local event_type=$(echo "$event_json" | jq -r '.type // empty' 2>/dev/null)
  local event_subtype=$(echo "$event_json" | jq -r '.subtype // empty' 2>/dev/null)
  if [ "$event_type" = "system" ] && [ "$event_subtype" = "init" ] && [ ! -f "$SESSION_ID_FILE" ]; then
    local session_id=$(echo "$event_json" | jq -r '.session_id // empty' 2>/dev/null)
    if [ -n "$session_id" ]; then
      echo "[VM0] Captured session ID: $session_id" >&2
      # Save to temp file to persist across subshells
      echo "$session_id" > "$SESSION_ID_FILE"
      # Calculate session history path
      # Claude Code uses hyphen-separated path encoding (e.g., /home/user/workspace -> -home-user-workspace)
      local project_name=$(echo "$WORKING_DIR" | sed 's|^/||' | sed 's|/|-|g')
      local session_history_path="$HOME/.config/claude/projects/-\${project_name}/\${session_id}.jsonl"
      echo "$session_history_path" > "$SESSION_HISTORY_PATH_FILE"
      echo "[VM0] Session history will be at: $session_history_path" >&2
    fi
  fi

  local payload=$(jq -n \\
    --arg rid "$RUN_ID" \\
    --argjson event "$event_json" \\
    '{runId: $rid, events: [$event]}')

  # Send event directly with curl (avoid eval to prevent shell injection)
  if [ -n "$VERCEL_BYPASS" ]; then
    curl -X POST "$WEBHOOK_URL" \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer $API_TOKEN" \\
      -H "x-vercel-protection-bypass: $VERCEL_BYPASS" \\
      -d "$payload" \\
      --connect-timeout 10 \\
      --max-time 30 \\
      --silent --fail || echo "[ERROR] Failed to send event" >&2
  else
    curl -X POST "$WEBHOOK_URL" \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer $API_TOKEN" \\
      -d "$payload" \\
      --connect-timeout 10 \\
      --max-time 30 \\
      --silent --fail || echo "[ERROR] Failed to send event" >&2
  fi
}
`;
