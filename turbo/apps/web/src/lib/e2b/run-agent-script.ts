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

# Variables for checkpoint (use temp files to persist across subshells)
SESSION_ID_FILE="/tmp/vm0-session-$RUN_ID.txt"
SESSION_HISTORY_PATH_FILE="/tmp/vm0-session-history-$RUN_ID.txt"

# Send single event immediately
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
      --silent --fail || echo "[ERROR] Failed to send event" >&2
  else
    curl -X POST "$WEBHOOK_URL" \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer $API_TOKEN" \\
      -d "$payload" \\
      --silent --fail || echo "[ERROR] Failed to send event" >&2
  fi
}

# Create checkpoint after successful run
create_checkpoint() {
  echo "[VM0] Creating checkpoint..." >&2

  # Read session ID from temp file
  if [ ! -f "$SESSION_ID_FILE" ]; then
    echo "[VM0] No session ID found, skipping checkpoint" >&2
    return 0
  fi
  local SESSION_ID=$(cat "$SESSION_ID_FILE")

  # Read session history path from temp file
  if [ ! -f "$SESSION_HISTORY_PATH_FILE" ]; then
    echo "[VM0] No session history path found, skipping checkpoint" >&2
    return 0
  fi
  local SESSION_HISTORY_PATH=$(cat "$SESSION_HISTORY_PATH_FILE")

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

      # Create Git snapshot - redirect stderr to suppress git messages
      SNAPSHOT=$(create_git_snapshot "$MOUNT_PATH" "$VOLUME_NAME" 2>/dev/null)

      if [ $? -eq 0 ] && [ -n "$SNAPSHOT" ]; then
        # Add snapshot to volume using temp files to avoid quoting issues
        local vol_tmp="/tmp/vol-$RUN_ID-$VOLUME_NAME.json"
        local snap_tmp="/tmp/snap-$RUN_ID-$VOLUME_NAME.json"
        local arr_tmp="/tmp/arr-$RUN_ID.json"

        echo "$volume" > "$vol_tmp"
        echo "$SNAPSHOT" > "$snap_tmp"
        echo "$snapshots_array" > "$arr_tmp"

        # Merge snapshot into volume
        volume=$(jq --slurpfile snap "$snap_tmp" '. + {snapshot: $snap[0]}' "$vol_tmp" 2>&1)
        if [ $? -ne 0 ]; then
          echo "[ERROR] Failed to merge snapshot into volume: $volume" >&2
          return 1
        fi

        echo "$volume" > "$vol_tmp"
        # Append volume to snapshots array
        snapshots_array=$(jq --slurpfile vol "$vol_tmp" '. + $vol' "$arr_tmp" 2>&1)
        if [ $? -ne 0 ]; then
          echo "[ERROR] Failed to append volume to array: $snapshots_array" >&2
          return 1
        fi

        rm -f "$vol_tmp" "$snap_tmp"

        echo "[VM0] Git snapshot created for '$VOLUME_NAME'" >&2
      else
        echo "[ERROR] Failed to create Git snapshot for '$VOLUME_NAME'" >&2
        return 1
      fi
    done < <(echo "$GIT_VOLUMES" | jq -c '.[]')

    VOLUME_SNAPSHOTS="$snapshots_array"
  fi

  echo "[VM0] Calling checkpoint API..." >&2

  # Build checkpoint payload - VOLUME_SNAPSHOTS is already valid JSON
  if [ -z "$VOLUME_SNAPSHOTS" ] || [ "$VOLUME_SNAPSHOTS" = "[]" ]; then
    VOLUME_SNAPSHOTS="[]"
  fi

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

  # Call checkpoint API directly (avoid eval)
  if [ -n "$VERCEL_BYPASS" ]; then
    if curl -X POST "$CHECKPOINT_URL" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $API_TOKEN" \
      -H "x-vercel-protection-bypass: $VERCEL_BYPASS" \
      -d "$checkpoint_payload" \
      --silent --fail; then
      echo "[VM0] Checkpoint created successfully" >&2
      return 0
    else
      echo "[ERROR] Failed to create checkpoint" >&2
      return 1
    fi
  else
    if curl -X POST "$CHECKPOINT_URL" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $API_TOKEN" \
      -d "$checkpoint_payload" \
      --silent --fail; then
      echo "[VM0] Checkpoint created successfully" >&2
      return 0
    else
      echo "[ERROR] Failed to create checkpoint" >&2
      return 1
    fi
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
      # Use jq to generate valid JSON
      jq -n --arg branch "$branch_name" --arg commit "$COMMIT_ID" '{branch: $branch, commitId: $commit}'
      return 0
    else
      return 1
    fi
  fi

  # Commit changes (suppress stdout and stderr)
  local commit_message="checkpoint: save state for run $RUN_ID"
  if ! git commit -m "$commit_message" >/dev/null 2>&1; then
    echo "[ERROR] Failed to commit changes" >&2
    return 1
  fi

  # Push to remote (suppress stdout and stderr)
  if ! git push origin "$branch_name" >/dev/null 2>&1; then
    echo "[ERROR] Failed to push branch $branch_name" >&2
    return 1
  fi

  # Get commit ID
  COMMIT_ID=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -z "$COMMIT_ID" ]; then
    echo "[ERROR] Failed to get commit ID" >&2
    return 1
  fi

  # Use jq to generate valid JSON
  jq -n --arg branch "$branch_name" --arg commit "$COMMIT_ID" '{branch: $branch, commitId: $commit}'
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

  # Create checkpoint if execution was successful (don't fail script if checkpoint fails)
  create_checkpoint || echo "[WARNING] Checkpoint creation failed, but run was successful" >&2
else
  echo "[VM0] Claude Code failed with exit code $CLAUDE_EXIT_CODE" >&2
  send_event "{\\"type\\": \\"result\\", \\"data\\": {\\"status\\": \\"failed\\", \\"exitCode\\": $CLAUDE_EXIT_CODE}}"
fi

# Cleanup temp files
rm -f "$SESSION_ID_FILE" "$SESSION_HISTORY_PATH_FILE" 2>/dev/null || true

exit $CLAUDE_EXIT_CODE
`;
