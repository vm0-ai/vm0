#!/bin/bash
set -e

# Get environment variables
RUN_ID="${VM0_RUN_ID}"
WEBHOOK_URL="${VM0_WEBHOOK_URL}"
WEBHOOK_TOKEN="${VM0_WEBHOOK_TOKEN}"
PROMPT="${VM0_PROMPT}"

# Send single event immediately
send_event() {
  local event_json="$1"

  local payload=$(jq -n \
    --arg rid "$RUN_ID" \
    --argjson event "$event_json" \
    '{runId: $rid, events: [$event]}')

  curl -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $WEBHOOK_TOKEN" \
    -d "$payload" \
    --silent --fail || echo "[ERROR] Failed to send event" >&2
}

# Execute Claude Code with JSONL output
echo "[VM0] Starting Claude Code execution..." >&2
echo "[VM0] Prompt: $PROMPT" >&2

# Run Claude Code and capture output
set +e  # Don't exit on Claude error
/usr/local/bin/claude --print \
       --verbose \
       --output-format stream-json \
       --dangerously-skip-permissions \
       "$PROMPT" 2>&1 | while IFS= read -r line; do

  # Skip empty lines
  if [ -z "$line" ]; then
    continue
  fi

  # Check if line is valid JSON
  if echo "$line" | jq empty 2>/dev/null; then
    # Valid JSONL - send immediately
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
    # Not JSON - log as stderr
    echo "[STDERR] $line" >&2
  fi
done

CLAUDE_EXIT_CODE=${PIPESTATUS[0]}
set -e

# Print newline after output
echo ""

# Send final result event
if [ $CLAUDE_EXIT_CODE -eq 0 ]; then
  echo "[VM0] Claude Code completed successfully" >&2
  send_event '{"type": "result", "data": {"status": "success", "exitCode": 0}}'
else
  echo "[VM0] Claude Code failed with exit code $CLAUDE_EXIT_CODE" >&2
  send_event "{\"type\": \"result\", \"data\": {\"status\": \"failed\", \"exitCode\": $CLAUDE_EXIT_CODE}}"
fi

exit $CLAUDE_EXIT_CODE
