/**
 * Main agent execution orchestrator script
 * This script sources the library scripts and coordinates execution
 */
export const RUN_AGENT_SCRIPT = `#!/bin/bash
set -e

# Source library scripts
SCRIPT_DIR="$(dirname "$0")"
source "\${SCRIPT_DIR}/lib/common.sh"
source "\${SCRIPT_DIR}/lib/send-event.sh"
source "\${SCRIPT_DIR}/lib/git-snapshot.sh"
source "\${SCRIPT_DIR}/lib/vm0-snapshot.sh"
source "\${SCRIPT_DIR}/lib/create-checkpoint.sh"

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

# Build Claude command - unified for both new and resume sessions
CLAUDE_ARGS="--print --verbose --output-format stream-json --dangerously-skip-permissions"
if [ -n "$RESUME_SESSION_ID" ]; then
  echo "[VM0] Resuming session: $RESUME_SESSION_ID" >&2
  CLAUDE_ARGS="$CLAUDE_ARGS --resume $RESUME_SESSION_ID"
else
  echo "[VM0] Starting new session" >&2
fi

# Execute Claude and process output stream
/usr/local/bin/claude $CLAUDE_ARGS "$PROMPT" 2>&1 | while IFS= read -r line; do
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

# Handle completion
if [ $CLAUDE_EXIT_CODE -eq 0 ]; then
  echo "[VM0] Claude Code completed successfully" >&2

  # Create checkpoint - this is mandatory for successful runs
  if ! create_checkpoint; then
    echo "[ERROR] Checkpoint creation failed, marking run as failed" >&2
    # Cleanup temp files
    rm -f "$SESSION_ID_FILE" "$SESSION_HISTORY_PATH_FILE" 2>/dev/null || true
    exit 1
  fi
else
  echo "[VM0] Claude Code failed with exit code $CLAUDE_EXIT_CODE" >&2
fi

# Cleanup temp files
rm -f "$SESSION_ID_FILE" "$SESSION_HISTORY_PATH_FILE" 2>/dev/null || true

exit $CLAUDE_EXIT_CODE
`;
