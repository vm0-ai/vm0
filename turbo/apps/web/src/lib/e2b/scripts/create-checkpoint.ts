/**
 * Checkpoint creation script
 * Creates checkpoints with conversation history and artifact snapshot (VAS only)
 */
export const CREATE_CHECKPOINT_SCRIPT = `# Create checkpoint after successful run
# Requires: COMMON_SCRIPT, VAS_SNAPSHOT_SCRIPT to be sourced first

create_checkpoint() {
  echo "[VM0] Creating checkpoint..." >&2

  # Read session ID from temp file
  if [ ! -f "$SESSION_ID_FILE" ]; then
    echo "[ERROR] No session ID found, checkpoint creation failed" >&2
    return 1
  fi
  local CLI_AGENT_SESSION_ID=$(cat "$SESSION_ID_FILE")

  # Read session history path from temp file
  if [ ! -f "$SESSION_HISTORY_PATH_FILE" ]; then
    echo "[ERROR] No session history path found, checkpoint creation failed" >&2
    return 1
  fi
  local SESSION_HISTORY_PATH=$(cat "$SESSION_HISTORY_PATH_FILE")

  # Check if session history file exists
  if [ ! -f "$SESSION_HISTORY_PATH" ]; then
    echo "[ERROR] Session history file not found at $SESSION_HISTORY_PATH, checkpoint creation failed" >&2
    return 1
  fi

  # Read session history
  CLI_AGENT_SESSION_HISTORY=$(cat "$SESSION_HISTORY_PATH" 2>/dev/null || echo "")
  if [ -z "$CLI_AGENT_SESSION_HISTORY" ]; then
    echo "[ERROR] Session history is empty, checkpoint creation failed" >&2
    return 1
  fi

  echo "[VM0] Session history loaded ($(echo "$CLI_AGENT_SESSION_HISTORY" | wc -l) lines)" >&2

  # CLI agent type (default to claude-code)
  local CLI_AGENT_TYPE="\${CLI_AGENT_TYPE:-claude-code}"

  # Create artifact snapshot (VAS only, required)
  if [ -z "$ARTIFACT_DRIVER" ] || [ -z "$ARTIFACT_VOLUME_NAME" ]; then
    echo "[ERROR] Artifact is required but not configured" >&2
    return 1
  fi

  echo "[VM0] Processing artifact with driver: $ARTIFACT_DRIVER" >&2

  if [ "$ARTIFACT_DRIVER" != "vas" ]; then
    echo "[ERROR] Unknown artifact driver: $ARTIFACT_DRIVER (only 'vas' is supported)" >&2
    return 1
  fi

  # VAS artifact: create vas snapshot
  echo "[VM0] Creating VAS snapshot for artifact '$ARTIFACT_VOLUME_NAME' at $ARTIFACT_MOUNT_PATH" >&2

  # Create VAS snapshot
  SNAPSHOT=$(create_vas_snapshot "$ARTIFACT_MOUNT_PATH" "artifact" "$ARTIFACT_VOLUME_NAME")

  if [ $? -ne 0 ] || [ -z "$SNAPSHOT" ]; then
    echo "[ERROR] Failed to create VAS snapshot for artifact" >&2
    return 1
  fi

  # Extract versionId from snapshot response
  local ARTIFACT_VERSION=$(echo "$SNAPSHOT" | jq -r '.versionId // empty')
  if [ -z "$ARTIFACT_VERSION" ]; then
    echo "[ERROR] Failed to extract versionId from snapshot" >&2
    return 1
  fi

  # Build artifact snapshot JSON with new format (artifactName + artifactVersion)
  ARTIFACT_SNAPSHOT=$(jq -n \\
    --arg artifactName "$ARTIFACT_VOLUME_NAME" \\
    --arg artifactVersion "$ARTIFACT_VERSION" \\
    '{artifactName: $artifactName, artifactVersion: $artifactVersion}')

  echo "[VM0] VAS artifact snapshot created: $ARTIFACT_VOLUME_NAME@$ARTIFACT_VERSION" >&2

  echo "[VM0] Calling checkpoint API..." >&2

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

  # Call checkpoint API directly (avoid eval) with timeout to prevent hanging
  if [ -n "$VERCEL_BYPASS" ]; then
    if curl -X POST "$CHECKPOINT_URL" \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer $API_TOKEN" \\
      -H "x-vercel-protection-bypass: $VERCEL_BYPASS" \\
      -d "$checkpoint_payload" \\
      --connect-timeout 10 \\
      --max-time 60 \\
      --silent --fail; then
      echo "[VM0] Checkpoint created successfully" >&2
      return 0
    else
      echo "[ERROR] Failed to create checkpoint" >&2
      return 1
    fi
  else
    if curl -X POST "$CHECKPOINT_URL" \\
      -H "Content-Type: application/json" \\
      -H "Authorization: Bearer $API_TOKEN" \\
      -d "$checkpoint_payload" \\
      --connect-timeout 10 \\
      --max-time 60 \\
      --silent --fail; then
      echo "[VM0] Checkpoint created successfully" >&2
      return 0
    else
      echo "[ERROR] Failed to create checkpoint" >&2
      return 1
    fi
  fi
}
`;
