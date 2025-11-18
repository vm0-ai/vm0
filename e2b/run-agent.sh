#!/bin/bash
set -e

# Get environment variables
RUNTIME_ID="${VM0_RUNTIME_ID}"
WEBHOOK_URL="${VM0_WEBHOOK_URL}"
WEBHOOK_TOKEN="${VM0_WEBHOOK_TOKEN}"
PROMPT="${VM0_PROMPT}"

# Batch configuration
BATCH_SIZE=10
BATCH_INTERVAL=1  # seconds

# Event accumulator
events_json="[]"
event_count=0

# Send events to webhook
send_events() {
  if [ "$event_count" -eq 0 ]; then
    return
  fi

  local payload=$(jq -n \
    --arg rid "$RUNTIME_ID" \
    --argjson events "$events_json" \
    '{runtimeId: $rid, events: $events}')

  curl -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "X-Vm0-Token: $WEBHOOK_TOKEN" \
    -d "$payload" \
    --silent --fail || echo "[ERROR] Failed to send events" >&2

  # Reset batch
  events_json="[]"
  event_count=0
}

# Send single event immediately
send_event() {
  local event_type="$1"
  local event_data="$2"

  local payload=$(jq -n \
    --arg rid "$RUNTIME_ID" \
    --arg type "$event_type" \
    --argjson data "$event_data" \
    '{runtimeId: $rid, events: [{type: $type, data: $data}]}')

  curl -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "X-Vm0-Token: $WEBHOOK_TOKEN" \
    -d "$payload" \
    --silent --fail || echo "[ERROR] Failed to send event" >&2
}

# Add event to batch
add_event() {
  local event_json="$1"

  events_json=$(echo "$events_json" | jq --argjson event "$event_json" '. + [$event]')
  event_count=$((event_count + 1))

  # Send batch if full
  if [ "$event_count" -ge "$BATCH_SIZE" ]; then
    send_events
  fi
}

# Send container start event
echo "[VM0] Sending container_start event..." >&2
send_event "container_start" '{"timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'

# Execute Claude Code with JSONL output
echo "[VM0] Starting Claude Code execution..." >&2
echo "[VM0] Prompt: $PROMPT" >&2

# Accumulator for final output
output_text=""

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
    # Valid JSONL - add to batch
    add_event "$line"

    # Extract text content from JSONL event for stdout
    event_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
    if [ "$event_type" = "content" ]; then
      text_content=$(echo "$line" | jq -r '.data.text // empty' 2>/dev/null)
      if [ -n "$text_content" ]; then
        echo -n "$text_content"
        output_text="${output_text}${text_content}"
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

# Send any remaining events
send_events

# Send final result event
if [ $CLAUDE_EXIT_CODE -eq 0 ]; then
  echo "[VM0] Claude Code completed successfully" >&2
  send_event "result" '{"status": "success", "exitCode": 0}'
else
  echo "[VM0] Claude Code failed with exit code $CLAUDE_EXIT_CODE" >&2
  send_event "result" "{\"status\": \"failed\", \"exitCode\": $CLAUDE_EXIT_CODE}"
fi

exit $CLAUDE_EXIT_CODE
