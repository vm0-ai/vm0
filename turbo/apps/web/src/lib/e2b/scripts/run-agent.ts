/**
 * Main agent execution orchestrator script
 * This script sources the library scripts and coordinates execution
 */
export const RUN_AGENT_SCRIPT = `#!/bin/bash
set -e

# Source library scripts
SCRIPT_DIR="$(dirname "$0")"
source "\${SCRIPT_DIR}/lib/common.sh"
source "\${SCRIPT_DIR}/lib/log.sh"
source "\${SCRIPT_DIR}/lib/request.sh"
source "\${SCRIPT_DIR}/lib/send-event.sh"
source "\${SCRIPT_DIR}/lib/vas-snapshot.sh"
source "\${SCRIPT_DIR}/lib/incremental-upload.sh"
source "\${SCRIPT_DIR}/lib/create-checkpoint.sh"

# Change to working directory
log_info "Working directory: $WORKING_DIR"
cd "$WORKING_DIR" || {
  log_error "Failed to change to working directory: $WORKING_DIR"
  exit 1
}

# Set Claude config directory to ensure consistent session history location
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
log_info "Claude config directory: $CLAUDE_CONFIG_DIR"

# Execute Claude Code with JSONL output
log_info "Starting Claude Code execution..."
log_info "Prompt: $PROMPT"

# Run Claude Code and capture output
set +e  # Don't exit on Claude error

# Build Claude command - unified for both new and resume sessions
CLAUDE_ARGS="--print --verbose --output-format stream-json --dangerously-skip-permissions"
if [ -n "$RESUME_SESSION_ID" ]; then
  log_info "Resuming session: $RESUME_SESSION_ID"
  CLAUDE_ARGS="$CLAUDE_ARGS --resume $RESUME_SESSION_ID"
else
  log_info "Starting new session"
fi

# Select Claude binary - use mock-claude for testing if USE_MOCK_CLAUDE is set
if [ "$USE_MOCK_CLAUDE" = "true" ]; then
  CLAUDE_BIN="/usr/local/bin/vm0-agent/lib/mock-claude.sh"
  log_info "Using mock-claude for testing"
else
  CLAUDE_BIN="claude"
fi

# Execute Claude and process output stream
"$CLAUDE_BIN" $CLAUDE_ARGS "$PROMPT" 2>&1 | while IFS= read -r line; do
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
    log_debug "Non-JSON output: $line"
  fi
done

CLAUDE_EXIT_CODE=\${PIPESTATUS[0]}
set -e

# Print newline after output
echo ""

# Check if any events failed to send
if [ -f "$EVENT_ERROR_FLAG" ]; then
  log_error "Some events failed to send, marking run as failed"
  rm -f "$EVENT_ERROR_FLAG" "$SESSION_ID_FILE" "$SESSION_HISTORY_PATH_FILE" 2>/dev/null || true
  exit 1
fi

# Handle completion
if [ $CLAUDE_EXIT_CODE -eq 0 ]; then
  log_info "Claude Code completed successfully"

  # Create checkpoint - this is mandatory for successful runs
  if ! create_checkpoint; then
    log_error "Checkpoint creation failed, marking run as failed"
    # Cleanup temp files
    rm -f "$SESSION_ID_FILE" "$SESSION_HISTORY_PATH_FILE" 2>/dev/null || true
    exit 1
  fi
else
  log_info "Claude Code failed with exit code $CLAUDE_EXIT_CODE"
fi

# Cleanup temp files
rm -f "$SESSION_ID_FILE" "$SESSION_HISTORY_PATH_FILE" "$EVENT_ERROR_FLAG" 2>/dev/null || true

exit $CLAUDE_EXIT_CODE
`;
