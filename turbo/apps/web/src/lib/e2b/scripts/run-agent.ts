/**
 * Main agent execution orchestrator script
 *
 * Responsibilities:
 * 1. Execute Claude Code and stream events to webhook
 * 2. Collect metrics via background process
 * 3. Create checkpoint on success
 * 4. Call complete API to signal finish and trigger sandbox cleanup
 *
 * Architecture:
 * - Events: Sent directly to webhook in real-time (no file-based buffering)
 * - Metrics: Collected by collect-metric.sh -> watch-log.sh batch uploads
 * - Cleanup: Single cleanup function called via EXIT trap (always runs)
 */
export const RUN_AGENT_SCRIPT = `#!/bin/bash
set -e

# =============================================================================
# Setup
# =============================================================================

SCRIPT_DIR="$(dirname "$0")"
source "\${SCRIPT_DIR}/lib/common.sh"
source "\${SCRIPT_DIR}/lib/log.sh"
source "\${SCRIPT_DIR}/lib/request.sh"
source "\${SCRIPT_DIR}/lib/send-event.sh"
source "\${SCRIPT_DIR}/lib/vas-snapshot.sh"
source "\${SCRIPT_DIR}/lib/incremental-upload.sh"
source "\${SCRIPT_DIR}/lib/create-checkpoint.sh"

# State variables (used by cleanup)
FINAL_EXIT_CODE=1
ERROR_MESSAGE="Script did not complete normally"
METRIC_PID=""
WATCH_LOG_PID=""

# =============================================================================
# Cleanup (single source of truth, called via EXIT trap)
# =============================================================================

cleanup() {
  local trap_exit_code=$?

  log_info "Cleanup started (trap_exit_code=$trap_exit_code, FINAL_EXIT_CODE=$FINAL_EXIT_CODE)"

  # Stop background processes
  for pid in "$METRIC_PID" "$WATCH_LOG_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  # Call complete API to signal finish and trigger sandbox cleanup
  log_info "Calling complete API (exitCode=$FINAL_EXIT_CODE)"

  local payload
  if [ -n "$ERROR_MESSAGE" ] && [ "$FINAL_EXIT_CODE" -ne 0 ]; then
    payload=$(jq -n --arg runId "$RUN_ID" --argjson exitCode "$FINAL_EXIT_CODE" --arg error "$ERROR_MESSAGE" \\
      '{runId: $runId, exitCode: $exitCode, error: $error}' 2>/dev/null) || payload=""
  else
    payload=$(jq -n --arg runId "$RUN_ID" --argjson exitCode "$FINAL_EXIT_CODE" \\
      '{runId: $runId, exitCode: $exitCode}' 2>/dev/null) || payload=""
  fi

  if [ -n "$payload" ]; then
    http_post_json "$COMPLETE_URL" "$payload" >/dev/null 2>&1 || log_error "Failed to call complete API"
  fi

  # Cleanup temp files
  rm -f "$SESSION_ID_FILE" "$SESSION_HISTORY_PATH_FILE" "$EVENT_ERROR_FLAG" 2>/dev/null || true

  log_info "Cleanup completed"
}

trap cleanup EXIT

# =============================================================================
# Initialize working directory
# =============================================================================

log_info "Working directory: $WORKING_DIR"
cd "$WORKING_DIR" || { log_error "Failed to cd to $WORKING_DIR"; exit 1; }

export CLAUDE_CONFIG_DIR="$HOME/.config/claude"

# =============================================================================
# Start background processes (metrics collection only)
# =============================================================================

LOG_DIR="/var/log/vm0"
mkdir -p "$LOG_DIR"

# Metrics collector -> metrics.jsonl
"\${SCRIPT_DIR}/lib/collect-metric.sh" &
METRIC_PID=$!
log_info "Started collect-metric.sh (PID: $METRIC_PID)"

# Watch-log batch uploads metrics
"\${SCRIPT_DIR}/lib/watch-log.sh" &
WATCH_LOG_PID=$!
log_info "Started watch-log.sh (PID: $WATCH_LOG_PID)"

# =============================================================================
# Execute Claude Code
# =============================================================================

log_info "Starting Claude Code..."
log_info "Prompt: $PROMPT"

# Build command args
CLAUDE_ARGS="--print --verbose --output-format stream-json --dangerously-skip-permissions"
if [ -n "$RESUME_SESSION_ID" ]; then
  log_info "Resuming session: $RESUME_SESSION_ID"
  CLAUDE_ARGS="$CLAUDE_ARGS --resume $RESUME_SESSION_ID"
fi

# Select binary (mock for testing)
CLAUDE_BIN="claude"
if [ "$USE_MOCK_CLAUDE" = "true" ]; then
  CLAUDE_BIN="/usr/local/bin/vm0-agent/lib/mock-claude.sh"
  log_info "Using mock-claude"
fi

# Execute and process output
set +e
"$CLAUDE_BIN" $CLAUDE_ARGS "$PROMPT" 2>"\${LOG_DIR}/errors.log" | while IFS= read -r line; do
  [ -z "$line" ] && continue

  # Validate JSON and send event
  if echo "$line" | jq empty 2>/dev/null; then
    send_event "$line"

    # Extract session ID from init event
    event_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
    event_subtype=$(echo "$line" | jq -r '.subtype // empty' 2>/dev/null)

    if [ "$event_type" = "system" ] && [ "$event_subtype" = "init" ] && [ ! -f "$SESSION_ID_FILE" ]; then
      session_id=$(echo "$line" | jq -r '.session_id // empty' 2>/dev/null)
      if [ -n "$session_id" ]; then
        log_info "Session ID: $session_id"
        echo "$session_id" > "$SESSION_ID_FILE"
        project_name=$(echo "$WORKING_DIR" | sed 's|^/||' | sed 's|/|-|g')
        echo "$HOME/.config/claude/projects/-\${project_name}/\${session_id}.jsonl" > "$SESSION_HISTORY_PATH_FILE"
      fi
    fi

    # Output result to stdout
    if [ "$event_type" = "result" ]; then
      echo "$line" | jq -r '.result // empty' 2>/dev/null
    fi
  fi
done
CLAUDE_EXIT_CODE=\${PIPESTATUS[0]}
set -e

echo ""

# =============================================================================
# Handle completion
# =============================================================================

FINAL_EXIT_CODE=$CLAUDE_EXIT_CODE
ERROR_MESSAGE=""

# Check for event send failures
if [ -f "$EVENT_ERROR_FLAG" ]; then
  log_error "Some events failed to send"
  FINAL_EXIT_CODE=1
  ERROR_MESSAGE="Some events failed to send"
fi

if [ $CLAUDE_EXIT_CODE -eq 0 ] && [ $FINAL_EXIT_CODE -eq 0 ]; then
  log_info "Claude completed successfully"

  # Create checkpoint (mandatory for success)
  if ! create_checkpoint; then
    log_error "Checkpoint creation failed"
    FINAL_EXIT_CODE=1
    ERROR_MESSAGE="Checkpoint creation failed"
  fi
else
  log_info "Claude failed (exit_code=$CLAUDE_EXIT_CODE)"
  if [ -f "\${LOG_DIR}/errors.log" ] && [ -s "\${LOG_DIR}/errors.log" ]; then
    ERROR_MESSAGE=$(tail -5 "\${LOG_DIR}/errors.log" | tr '\\n' ' ' | sed 's/  */ /g' | xargs)
  else
    ERROR_MESSAGE="Agent exited with code $CLAUDE_EXIT_CODE"
  fi
fi

# Exit triggers cleanup via trap
exit $FINAL_EXIT_CODE
`;
