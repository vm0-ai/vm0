/**
 * Agent execution script content
 * This script is uploaded to the E2B sandbox at runtime
 */
export const RUN_AGENT_SCRIPT = `#!/bin/bash
set -e

# Get environment variables
RUN_ID="\${VM0_RUN_ID}"
API_URL="\${VM0_API_URL}"
API_TOKEN="\${VM0_API_TOKEN}"
PROMPT="\${VM0_PROMPT}"
WORKING_DIR="\${VM0_WORKING_DIR:-/home/user}"
VERCEL_BYPASS="\${VERCEL_PROTECTION_BYPASS:-}"
GIT_VOLUMES="\${VM0_GIT_VOLUMES:-[]}"

# Construct webhook endpoint URLs
WEBHOOK_URL="\${API_URL}/api/webhooks/agent/events"
CHECKPOINT_URL="\${API_URL}/api/webhooks/agent/checkpoints"

# Variables for checkpoint
SESSION_ID=""
SESSION_HISTORY_PATH=""

# Send single event immediately
send_event() {
  local event_json="$1"

  # Extract session ID from init event
  local event_type=$(echo "$event_json" | jq -r '.type // empty' 2>/dev/null)
  if [ "$event_type" = "init" ] && [ -z "$SESSION_ID" ]; then
    SESSION_ID=$(echo "$event_json" | jq -r '.data.sessionId // empty' 2>/dev/null)
    if [ -n "$SESSION_ID" ]; then
      echo "[VM0] Captured session ID: $SESSION_ID" >&2
      # Calculate session history path
      # Encode working directory path (replace / with _)
      local encoded_path=$(echo "$WORKING_DIR" | sed 's|/|_|g')
      SESSION_HISTORY_PATH="$HOME/.config/claude/projects/\${encoded_path}/\${SESSION_ID}.jsonl"
      echo "[VM0] Session history will be at: $SESSION_HISTORY_PATH" >&2
    fi
  fi

  local payload=$(jq -n \\
    --arg rid "$RUN_ID" \\
    --argjson event "$event_json" \\
    '{runId: $rid, events: [$event]}')

  # Build curl command with optional Vercel bypass header
  local curl_cmd="curl -X POST \\"$WEBHOOK_URL\\" \\
    -H \\"Content-Type: application/json\\" \\
    -H \\"Authorization: Bearer $API_TOKEN\\""

  # Add Vercel protection bypass header if available (for preview deployments)
  if [ -n "$VERCEL_BYPASS" ]; then
    curl_cmd="$curl_cmd -H \\"x-vercel-protection-bypass: $VERCEL_BYPASS\\""
  fi

  curl_cmd="$curl_cmd -d '$payload' --silent --fail"

  eval "$curl_cmd" || echo "[ERROR] Failed to send event" >&2
}

# Create checkpoint after successful run
create_checkpoint() {
  echo "[VM0] Creating checkpoint..." >&2

  # Check if we have session ID
  if [ -z "$SESSION_ID" ]; then
    echo "[VM0] No session ID found, skipping checkpoint" >&2
    return 0
  fi

  # Check if session history file exists
  if [ ! -f "$SESSION_HISTORY_PATH" ]; then
    echo "[VM0] Session history file not found at $SESSION_HISTORY_PATH, skipping checkpoint" >&2
    return 0
  fi

  # Read session history
  SESSION_HISTORY=$(cat "$SESSION_HISTORY_PATH" 2>/dev/null || echo "")
  if [ -z "$SESSION_HISTORY" ]; then
    echo "[VM0] Session history is empty, skipping checkpoint" >&2
    return 0
  fi

  echo "[VM0] Session history loaded ($(echo "$SESSION_HISTORY" | wc -l) lines)" >&2

  # Create Git snapshots for each Git volume
  VOLUME_SNAPSHOTS="[]"

  if [ "$GIT_VOLUMES" != "[]" ]; then
    echo "[VM0] Processing $(echo "$GIT_VOLUMES" | jq 'length') Git volume(s)..." >&2

    # Iterate over Git volumes
    VOLUME_SNAPSHOTS=$(echo "$GIT_VOLUMES" | jq -c '.[] | {
      name: .name,
      driver: .driver,
      mountPath: .mountPath,
      snapshot: null
    }')

    # Array to collect all snapshots
    local snapshots_array="[]"

    while IFS= read -r volume; do
      VOLUME_NAME=$(echo "$volume" | jq -r '.name')
      MOUNT_PATH=$(echo "$volume" | jq -r '.mountPath')

      echo "[VM0] Creating Git snapshot for volume '$VOLUME_NAME' at $MOUNT_PATH" >&2

      # Create Git snapshot
      SNAPSHOT=$(create_git_snapshot "$MOUNT_PATH" "$VOLUME_NAME")

      if [ $? -eq 0 ] && [ -n "$SNAPSHOT" ]; then
        # Add snapshot to volume
        volume=$(echo "$volume" | jq --argjson snap "$SNAPSHOT" '.snapshot = $snap')
        snapshots_array=$(echo "$snapshots_array" | jq --argjson vol "$volume" '. + [$vol]')
        echo "[VM0] Git snapshot created for '$VOLUME_NAME'" >&2
      else
        echo "[ERROR] Failed to create Git snapshot for '$VOLUME_NAME'" >&2
        return 1
      fi
    done < <(echo "$GIT_VOLUMES" | jq -c '.[]')

    VOLUME_SNAPSHOTS="$snapshots_array"
  fi

  echo "[VM0] Calling checkpoint API..." >&2

  # Build checkpoint payload
  local checkpoint_payload=$(jq -n \\
    --arg rid "$RUN_ID" \\
    --arg sid "$SESSION_ID" \\
    --arg history "$SESSION_HISTORY" \\
    --argjson volumes "$VOLUME_SNAPSHOTS" \\
    '{
      runId: $rid,
      sessionId: $sid,
      sessionHistory: $history,
      volumeSnapshots: $volumes
    }')

  # Build curl command
  local curl_cmd="curl -X POST \\"$CHECKPOINT_URL\\" \\
    -H \\"Content-Type: application/json\\" \\
    -H \\"Authorization: Bearer $API_TOKEN\\""

  # Add Vercel protection bypass header if available
  if [ -n "$VERCEL_BYPASS" ]; then
    curl_cmd="$curl_cmd -H \\"x-vercel-protection-bypass: $VERCEL_BYPASS\\""
  fi

  curl_cmd="$curl_cmd -d '$checkpoint_payload' --silent --fail"

  # Call checkpoint API
  if eval "$curl_cmd"; then
    echo "[VM0] Checkpoint created successfully" >&2
    return 0
  else
    echo "[ERROR] Failed to create checkpoint" >&2
    return 1
  fi
}

# Create Git snapshot for a volume
create_git_snapshot() {
  local mount_path="$1"
  local volume_name="$2"
  local branch_name="run-$RUN_ID"

  # Change to volume directory
  cd "$mount_path" || {
    echo "[ERROR] Failed to cd to $mount_path" >&2
    return 1
  }

  # Configure Git user
  git config user.name "VM0 Agent" 2>/dev/null || true
  git config user.email "agent@vm0.ai" 2>/dev/null || true

  # Create and switch to new branch
  if ! git checkout -b "$branch_name" 2>/dev/null; then
    echo "[ERROR] Failed to create branch $branch_name" >&2
    return 1
  fi

  # Stage all changes
  git add -A 2>/dev/null || true

  # Check if there are changes to commit
  if git diff --cached --quiet 2>/dev/null; then
    echo "[VM0] No changes to commit in volume '$volume_name'" >&2
    # Still return current commit
    COMMIT_ID=$(git rev-parse HEAD 2>/dev/null || echo "")
    if [ -n "$COMMIT_ID" ]; then
      echo "{\\"branch\\": \\"$branch_name\\", \\"commitId\\": \\"$COMMIT_ID\\"}"
      return 0
    else
      return 1
    fi
  fi

  # Commit changes
  local commit_message="checkpoint: save state for run $RUN_ID"
  if ! git commit -m "$commit_message" 2>/dev/null; then
    echo "[ERROR] Failed to commit changes" >&2
    return 1
  fi

  # Push to remote
  if ! git push origin "$branch_name" 2>/dev/null; then
    echo "[ERROR] Failed to push branch $branch_name" >&2
    return 1
  fi

  # Get commit ID
  COMMIT_ID=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -z "$COMMIT_ID" ]; then
    echo "[ERROR] Failed to get commit ID" >&2
    return 1
  fi

  echo "{\\"branch\\": \\"$branch_name\\", \\"commitId\\": \\"$COMMIT_ID\\"}"
  return 0
}

# Change to working directory
echo "[VM0] Working directory: $WORKING_DIR" >&2
cd "$WORKING_DIR" || {
  echo "[ERROR] Failed to change to working directory: $WORKING_DIR" >&2
  exit 1
}

# Set Claude config directory to ensure consistent session history location
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
echo "[VM0] Claude config directory: $CLAUDE_CONFIG_DIR" >&2

# Execute Claude Code with JSONL output
echo "[VM0] Starting Claude Code execution..." >&2
echo "[VM0] Prompt: $PROMPT" >&2

# Run Claude Code and capture output
set +e  # Don't exit on Claude error
/usr/local/bin/claude --print \\
       --verbose \\
       --output-format stream-json \\
       --dangerously-skip-permissions \\
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

CLAUDE_EXIT_CODE=\${PIPESTATUS[0]}
set -e

# Print newline after output
echo ""

# Send final result event
if [ $CLAUDE_EXIT_CODE -eq 0 ]; then
  echo "[VM0] Claude Code completed successfully" >&2
  send_event '{"type": "result", "data": {"status": "success", "exitCode": 0}}'

  # Create checkpoint if execution was successful
  create_checkpoint
else
  echo "[VM0] Claude Code failed with exit code $CLAUDE_EXIT_CODE" >&2
  send_event "{\\"type\\": \\"result\\", \\"data\\": {\\"status\\": \\"failed\\", \\"exitCode\\": $CLAUDE_EXIT_CODE}}"
fi

exit $CLAUDE_EXIT_CODE
`;
