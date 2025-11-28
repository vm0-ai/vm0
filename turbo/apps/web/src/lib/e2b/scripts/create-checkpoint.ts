/**
 * Checkpoint creation script
 * Creates checkpoints with conversation history and artifact snapshot (VAS only)
 */
export const CREATE_CHECKPOINT_SCRIPT = `# Create checkpoint after successful run
# Requires: COMMON_SCRIPT, LOG_SCRIPT, REQUEST_SCRIPT, VAS_SNAPSHOT_SCRIPT to be sourced first

create_checkpoint() {
  log_info "Creating checkpoint..."

  # Read session ID from temp file
  if [ ! -f "$SESSION_ID_FILE" ]; then
    log_error "No session ID found, checkpoint creation failed"
    return 1
  fi
  local CLI_AGENT_SESSION_ID=$(cat "$SESSION_ID_FILE")

  # Read session history path from temp file
  if [ ! -f "$SESSION_HISTORY_PATH_FILE" ]; then
    log_error "No session history path found, checkpoint creation failed"
    return 1
  fi
  local SESSION_HISTORY_PATH=$(cat "$SESSION_HISTORY_PATH_FILE")

  # Check if session history file exists
  if [ ! -f "$SESSION_HISTORY_PATH" ]; then
    log_error "Session history file not found at $SESSION_HISTORY_PATH, checkpoint creation failed"
    return 1
  fi

  # Read session history
  CLI_AGENT_SESSION_HISTORY=$(cat "$SESSION_HISTORY_PATH" 2>/dev/null || echo "")
  if [ -z "$CLI_AGENT_SESSION_HISTORY" ]; then
    log_error "Session history is empty, checkpoint creation failed"
    return 1
  fi

  log_info "Session history loaded ($(echo "$CLI_AGENT_SESSION_HISTORY" | wc -l) lines)"

  # CLI agent type (default to claude-code)
  local CLI_AGENT_TYPE="\${CLI_AGENT_TYPE:-claude-code}"

  # Create artifact snapshot (VAS only, required)
  if [ -z "$ARTIFACT_DRIVER" ] || [ -z "$ARTIFACT_VOLUME_NAME" ]; then
    log_error "Artifact is required but not configured"
    return 1
  fi

  log_info "Processing artifact with driver: $ARTIFACT_DRIVER"

  if [ "$ARTIFACT_DRIVER" != "vas" ]; then
    log_error "Unknown artifact driver: $ARTIFACT_DRIVER (only 'vas' is supported)"
    return 1
  fi

  # VAS artifact: create vas snapshot
  log_info "Creating VAS snapshot for artifact '$ARTIFACT_VOLUME_NAME' at $ARTIFACT_MOUNT_PATH"

  # Create VAS snapshot
  SNAPSHOT=$(create_vas_snapshot "$ARTIFACT_MOUNT_PATH" "artifact" "$ARTIFACT_VOLUME_NAME")

  if [ $? -ne 0 ] || [ -z "$SNAPSHOT" ]; then
    log_error "Failed to create VAS snapshot for artifact"
    return 1
  fi

  # Extract versionId from snapshot response
  local ARTIFACT_VERSION=$(echo "$SNAPSHOT" | jq -r '.versionId // empty')
  if [ -z "$ARTIFACT_VERSION" ]; then
    log_error "Failed to extract versionId from snapshot"
    return 1
  fi

  # Build artifact snapshot JSON with new format (artifactName + artifactVersion)
  ARTIFACT_SNAPSHOT=$(jq -n \\
    --arg artifactName "$ARTIFACT_VOLUME_NAME" \\
    --arg artifactVersion "$ARTIFACT_VERSION" \\
    '{artifactName: $artifactName, artifactVersion: $artifactVersion}')

  log_info "VAS artifact snapshot created: $ARTIFACT_VOLUME_NAME@$ARTIFACT_VERSION"

  log_info "Calling checkpoint API..."

  # Build checkpoint payload with new schema
  local checkpoint_payload=$(jq -n \\
    --arg rid "$RUN_ID" \\
    --arg cliAgentType "$CLI_AGENT_TYPE" \\
    --arg cliAgentSessionId "$CLI_AGENT_SESSION_ID" \\
    --arg cliAgentSessionHistory "$CLI_AGENT_SESSION_HISTORY" \\
    --argjson artifactSnapshot "$ARTIFACT_SNAPSHOT" \\
    '{
      runId: $rid,
      cliAgentType: $cliAgentType,
      cliAgentSessionId: $cliAgentSessionId,
      cliAgentSessionHistory: $cliAgentSessionHistory,
      artifactSnapshot: $artifactSnapshot
    }')

  # Call checkpoint API using unified HTTP request function
  if http_post_json "$CHECKPOINT_URL" "$checkpoint_payload" >/dev/null; then
    log_info "Checkpoint created successfully"
    return 0
  else
    log_error "Failed to create checkpoint"
    return 1
  fi
}
`;
