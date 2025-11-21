/**
 * Agent execution script content
 * This script is uploaded to the E2B sandbox at runtime
 */
export const RUN_AGENT_SCRIPT = `#!/bin/bash
set -e

# Get environment variables
RUN_ID="\${VM0_RUN_ID}"
API_URL="\${VM0_API_URL:-http://localhost:3000}"
API_TOKEN="\${VM0_API_TOKEN}"
PROMPT="\${VM0_PROMPT}"
WORKING_DIR="\${VM0_WORKING_DIR:-/home/user}"
VERCEL_BYPASS="\${VERCEL_PROTECTION_BYPASS:-}"
SESSION_ID="\${VM0_SESSION_ID:-}"

# Construct webhook URLs from API_URL
EVENTS_WEBHOOK_URL="$API_URL/api/webhooks/agent/events"
CHECKPOINTS_WEBHOOK_URL="$API_URL/api/webhooks/agent/checkpoints"

# Send single event immediately
send_event() {
  local event_json="$1"

  local payload=$(jq -n \\
    --arg rid "$RUN_ID" \\
    --argjson event "$event_json" \\
    '{runId: $rid, events: [$event]}')

  # Build curl command with optional Vercel bypass header
  local curl_cmd="curl -X POST \\"$EVENTS_WEBHOOK_URL\\" \\
    -H \\"Content-Type: application/json\\" \\
    -H \\"Authorization: Bearer $API_TOKEN\\""

  # Add Vercel protection bypass header if available (for preview deployments)
  if [ -n "$VERCEL_BYPASS" ]; then
    curl_cmd="$curl_cmd -H \\"x-vercel-protection-bypass: $VERCEL_BYPASS\\""
  fi

  curl_cmd="$curl_cmd -d '$payload' --silent --fail"

  eval "$curl_cmd" || echo "[ERROR] Failed to send event" >&2
}

# Change to working directory
echo "[VM0] Working directory: $WORKING_DIR" >&2
cd "$WORKING_DIR" || {
  echo "[ERROR] Failed to change to working directory: $WORKING_DIR" >&2
  exit 1
}

# Execute Claude Code with JSONL output
echo "[VM0] Starting Claude Code execution..." >&2

# Build Claude command with optional resume flag
CLAUDE_CMD="/usr/local/bin/claude --print --verbose --output-format stream-json --dangerously-skip-permissions"

# Check if resuming from checkpoint
if [ -n "$SESSION_ID" ]; then
  echo "[VM0] Resuming from session: $SESSION_ID" >&2
  CLAUDE_CMD="$CLAUDE_CMD -r $SESSION_ID"
else
  echo "[VM0] Starting new session" >&2
  echo "[VM0] Prompt: $PROMPT" >&2
fi

CLAUDE_CMD="$CLAUDE_CMD \\"$PROMPT\\""

# Run Claude Code and capture output
set +e  # Don't exit on Claude error
eval "$CLAUDE_CMD" 2>&1 | while IFS= read -r line; do

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

CLAUDE_EXIT_CODE=\${PIPESTATUS[0]}
set -e

# Print newline after output
echo ""

# Send final result event
if [ $CLAUDE_EXIT_CODE -eq 0 ]; then
  echo "[VM0] Claude Code completed successfully" >&2
  send_event '{"type": "result", "data": {"status": "success", "exitCode": 0}}'

  # Save checkpoint after successful completion
  echo "[VM0] Saving checkpoint..." >&2

  # Calculate encodedPath from working directory
  ENCODED_PATH=$(echo -n "$WORKING_DIR" | base64 -w 0 2>/dev/null || echo -n "$WORKING_DIR" | base64)
  SESSION_DIR="$HOME/.config/claude/projects/$ENCODED_PATH"

  # Find the most recent session file (in case SESSION_ID is not set)
  if [ -z "$SESSION_ID" ]; then
    SESSION_FILE=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
    if [ -n "$SESSION_FILE" ]; then
      SESSION_ID=$(basename "$SESSION_FILE" .jsonl)
    fi
  else
    SESSION_FILE="$SESSION_DIR/$SESSION_ID.jsonl"
  fi

  if [ -f "$SESSION_FILE" ]; then
    echo "[VM0] Found session file: $SESSION_FILE" >&2

    # Read session content and escape for JSON
    SESSION_CONTENT=$(cat "$SESSION_FILE" | jq -Rs .)

    # Build checkpoint payload
    CHECKPOINT_PAYLOAD=$(jq -n \\\\
      --arg runId "$RUN_ID" \\\\
      --arg sessionId "$SESSION_ID" \\\\
      --argjson sessionContent "$SESSION_CONTENT" \\\\
      --arg workingDirectory "$WORKING_DIR" \\\\
      --arg encodedPath "$ENCODED_PATH" \\\\
      '{
        runId: $runId,
        sessionId: $sessionId,
        sessionContent: $sessionContent,
        workingDirectory: $workingDirectory,
        encodedPath: $encodedPath,
        volumeSnapshots: []
      }')

    # Build curl command for checkpoint
    CHECKPOINT_CURL="curl -X POST \\"$CHECKPOINTS_WEBHOOK_URL\\" \\\\
      -H \\"Content-Type: application/json\\" \\\\
      -H \\"Authorization: Bearer $API_TOKEN\\""

    # Add Vercel protection bypass header if available
    if [ -n "$VERCEL_BYPASS" ]; then
      CHECKPOINT_CURL="$CHECKPOINT_CURL -H \\"x-vercel-protection-bypass: $VERCEL_BYPASS\\""
    fi

    CHECKPOINT_CURL="$CHECKPOINT_CURL -d '$CHECKPOINT_PAYLOAD' --silent --show-error"

    if eval "$CHECKPOINT_CURL"; then
      echo "[VM0] Checkpoint saved successfully" >&2
    else
      echo "[VM0] Warning: Failed to save checkpoint" >&2
    fi
  else
    echo "[VM0] Warning: Session file not found at $SESSION_FILE, skipping checkpoint" >&2
  fi
else
  echo "[VM0] Claude Code failed with exit code $CLAUDE_EXIT_CODE" >&2
  send_event "{\\"type\\": \\"result\\", \\"data\\": {\\"status\\": \\"failed\\", \\"exitCode\\": $CLAUDE_EXIT_CODE}}"
fi

exit $CLAUDE_EXIT_CODE
`;
