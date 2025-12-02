/**
 * Main agent execution orchestrator script
 * This script sources the library scripts and coordinates execution
 *
 * Architecture (Phase 1 - File-based with dual watchers):
 * - Claude output -> /var/log/vm0/agent.jsonl -> watch-agent.sh (real-time upload)
 * - Metrics -> /var/log/vm0/metrics.jsonl -> watch-log.sh (batch upload)
 * - Errors -> /var/log/vm0/errors.log -> watch-log.sh (batch upload)
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

# Log directory for file-based architecture
LOG_DIR="/var/log/vm0"
AGENT_LOG_FILE="\${LOG_DIR}/agent.jsonl"
ERRORS_LOG_FILE="\${LOG_DIR}/errors.log"

# Create log directory and initialize files
mkdir -p "$LOG_DIR"
touch "$AGENT_LOG_FILE"
touch "$ERRORS_LOG_FILE"

# PIDs for background processes
METRIC_PID=""
WATCH_AGENT_PID=""
WATCH_LOG_PID=""

# Track if cleanup has been called (to prevent double cleanup)
CLEANUP_CALLED=""

# Cleanup function to stop background processes
cleanup_background_processes() {
  log_info "Stopping background processes..."

  # Kill metrics collector
  if [ -n "$METRIC_PID" ] && kill -0 "$METRIC_PID" 2>/dev/null; then
    kill "$METRIC_PID" 2>/dev/null || true
    wait "$METRIC_PID" 2>/dev/null || true
  fi

  # Kill watch-agent (give it time to flush)
  if [ -n "$WATCH_AGENT_PID" ] && kill -0 "$WATCH_AGENT_PID" 2>/dev/null; then
    kill "$WATCH_AGENT_PID" 2>/dev/null || true
    wait "$WATCH_AGENT_PID" 2>/dev/null || true
  fi

  # Kill watch-log (give it time to flush final data)
  if [ -n "$WATCH_LOG_PID" ] && kill -0 "$WATCH_LOG_PID" 2>/dev/null; then
    # Send SIGTERM to trigger final flush via trap
    kill -TERM "$WATCH_LOG_PID" 2>/dev/null || true
    # Wait a bit for final flush
    sleep 2
    kill -9 "$WATCH_LOG_PID" 2>/dev/null || true
    wait "$WATCH_LOG_PID" 2>/dev/null || true
  fi

  log_info "Background processes stopped"
}

# Emergency cleanup function - called on any exit to ensure sandbox cleanup
# This is critical to prevent sandbox leaks
emergency_cleanup() {
  local exit_code=$?

  # Prevent double cleanup
  if [ -n "$CLEANUP_CALLED" ]; then
    return
  fi
  CLEANUP_CALLED="true"

  log_info "Emergency cleanup triggered (exit_code=$exit_code)"

  # Stop background processes
  cleanup_background_processes 2>/dev/null || true

  # Always call complete API to ensure sandbox is killed
  # Use a default error message if we're exiting abnormally
  local error_msg=""
  if [ $exit_code -ne 0 ]; then
    error_msg="Script exited unexpectedly with code $exit_code"
  fi

  local payload
  if [ -n "$error_msg" ]; then
    payload=$(jq -n --arg runId "$RUN_ID" --argjson exitCode "$exit_code" --arg error "$error_msg" '{runId: $runId, exitCode: $exitCode, error: $error}' 2>/dev/null || echo "{}")
  else
    payload=$(jq -n --arg runId "$RUN_ID" --argjson exitCode "$exit_code" '{runId: $runId, exitCode: $exitCode}' 2>/dev/null || echo "{}")
  fi

  if [ -n "$payload" ] && [ "$payload" != "{}" ]; then
    log_info "Calling complete API from emergency cleanup..."
    http_post_json "$COMPLETE_URL" "$payload" >/dev/null 2>&1 || log_error "Failed to call complete API in emergency cleanup"
  fi

  # Cleanup temp files
  rm -f "$SESSION_ID_FILE" "$SESSION_HISTORY_PATH_FILE" "$EVENT_ERROR_FLAG" "$STDERR_FILE" 2>/dev/null || true
}

# Set up EXIT trap to ensure cleanup always runs
trap emergency_cleanup EXIT

# Change to working directory
log_info "Working directory: $WORKING_DIR"
cd "$WORKING_DIR" || {
  log_error "Failed to change to working directory: $WORKING_DIR"
  exit 1
}

# Set Claude config directory to ensure consistent session history location
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
log_info "Claude config directory: $CLAUDE_CONFIG_DIR"

# Start background processes for metrics collection and log watching
log_info "Starting background processes..."

# Start metrics collector (writes to metrics.jsonl)
"\${SCRIPT_DIR}/lib/collect-metric.sh" &
METRIC_PID=$!
log_info "Started collect-metric.sh (PID: $METRIC_PID)"

# Start watch-agent (streams agent events in real-time)
"\${SCRIPT_DIR}/lib/watch-agent.sh" &
WATCH_AGENT_PID=$!
log_info "Started watch-agent.sh (PID: $WATCH_AGENT_PID)"

# Start watch-log (batch uploads metrics and errors)
"\${SCRIPT_DIR}/lib/watch-log.sh" &
WATCH_LOG_PID=$!
log_info "Started watch-log.sh (PID: $WATCH_LOG_PID)"

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

# Execute Claude and process output
# - Send events to webhook in real-time
# - Write to log file for metrics watcher
# - Extract session ID for checkpoint
"$CLAUDE_BIN" $CLAUDE_ARGS "$PROMPT" 2>"$ERRORS_LOG_FILE" | while IFS= read -r line; do
  # Write to log file (for watch-log.sh to read errors if any)
  echo "$line" >> "$AGENT_LOG_FILE"

  # Skip empty lines for processing
  if [ -z "$line" ]; then
    continue
  fi

  # Check if line is valid JSON (stdout should only contain JSONL)
  if echo "$line" | jq empty 2>/dev/null; then
    # Send event to webhook immediately
    send_event "$line"

    # Extract session ID from init event (needed for checkpoint)
    event_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
    event_subtype=$(echo "$line" | jq -r '.subtype // empty' 2>/dev/null)
    if [ "$event_type" = "system" ] && [ "$event_subtype" = "init" ] && [ ! -f "$SESSION_ID_FILE" ]; then
      session_id=$(echo "$line" | jq -r '.session_id // empty' 2>/dev/null)
      if [ -n "$session_id" ]; then
        log_info "Captured session ID: $session_id"
        echo "$session_id" > "$SESSION_ID_FILE"
        # Calculate session history path
        project_name=$(echo "$WORKING_DIR" | sed 's|^/||' | sed 's|/|-|g')
        session_history_path="$HOME/.config/claude/projects/-\${project_name}/\${session_id}.jsonl"
        echo "$session_history_path" > "$SESSION_HISTORY_PATH_FILE"
        log_info "Session history will be at: $session_history_path"
      fi
    fi

    # Extract result from "result" event for stdout display
    if [ "$event_type" = "result" ]; then
      result_content=$(echo "$line" | jq -r '.result // empty' 2>/dev/null)
      if [ -n "$result_content" ]; then
        echo "$result_content"
      fi
    fi
  fi
done

CLAUDE_EXIT_CODE=\${PIPESTATUS[0]}
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
    if [ -f "$ERRORS_LOG_FILE" ] && [ -s "$ERRORS_LOG_FILE" ]; then
      # Get last few lines of stderr, clean up formatting
      ERROR_MESSAGE=$(tail -5 "$ERRORS_LOG_FILE" | tr '\\n' ' ' | sed 's/  */ /g' | xargs)
      log_info "Captured stderr: $ERROR_MESSAGE"
    else
      ERROR_MESSAGE="Agent exited with code $CLAUDE_EXIT_CODE"
    fi
  fi
fi

# Stop background processes and perform final flush
cleanup_background_processes

# Mark cleanup as called to prevent emergency_cleanup from running
CLEANUP_CALLED="true"

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
