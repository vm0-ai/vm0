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
# Use process substitution to avoid pipeline process group issues
# This ensures the script continues after Claude exits
while IFS= read -r line; do
  # Skip empty lines
  if [ -z "$line" ]; then
    continue
  fi

  # Check if line is valid JSON (stdout should only contain JSONL)
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
  fi
done < <("$CLAUDE_BIN" $CLAUDE_ARGS "$PROMPT" 2>"$STDERR_FILE")
CLAUDE_EXIT_CODE=$?
set -e

# Print newline after output
echo ""

# Track final exit code for complete API
FINAL_EXIT_CODE=$CLAUDE_EXIT_CODE
ERROR_MESSAGE=""

# Check if any events failed to send
if [ -f "$EVENT_ERROR_FLAG" ]; then
  log_error "Some events failed to send, marking run as failed"
  FINAL_EXIT_CODE=1
  ERROR_MESSAGE="Some events failed to send"
fi

# Handle completion
if [ $CLAUDE_EXIT_CODE -eq 0 ] && [ $FINAL_EXIT_CODE -eq 0 ]; then
  log_info "Claude Code completed successfully"

  # Create checkpoint - this is mandatory for successful runs
  if ! create_checkpoint; then
    log_error "Checkpoint creation failed, marking run as failed"
    FINAL_EXIT_CODE=1
    ERROR_MESSAGE="Checkpoint creation failed"
  fi
else
  if [ $CLAUDE_EXIT_CODE -ne 0 ]; then
    log_info "Claude Code failed with exit code $CLAUDE_EXIT_CODE"
    # Try to get detailed error from stderr file
    if [ -f "$STDERR_FILE" ] && [ -s "$STDERR_FILE" ]; then
      # Get last few lines of stderr, clean up formatting
      ERROR_MESSAGE=$(tail -5 "$STDERR_FILE" | tr '\\n' ' ' | sed 's/  */ /g' | xargs)
      log_info "Captured stderr: $ERROR_MESSAGE"
    else
      ERROR_MESSAGE="Agent exited with code $CLAUDE_EXIT_CODE"
    fi
  fi
fi

# Always call complete API at the end
# This sends vm0_result (on success) or vm0_error (on failure) and kills the sandbox
log_info "Calling complete API with exitCode=$FINAL_EXIT_CODE"

complete_payload=$(jq -n \\
  --arg runId "$RUN_ID" \\
  --argjson exitCode "$FINAL_EXIT_CODE" \\
  --arg error "$ERROR_MESSAGE" \\
  'if $error == "" then {runId: $runId, exitCode: $exitCode} else {runId: $runId, exitCode: $exitCode, error: $error} end')

if http_post_json "$COMPLETE_URL" "$complete_payload" >/dev/null; then
  log_info "Complete API called successfully"
else
  log_error "Failed to call complete API (sandbox may not be cleaned up)"
fi

# Cleanup temp files
rm -f "$SESSION_ID_FILE" "$SESSION_HISTORY_PATH_FILE" "$EVENT_ERROR_FLAG" "$STDERR_FILE" 2>/dev/null || true

exit $FINAL_EXIT_CODE
`;
