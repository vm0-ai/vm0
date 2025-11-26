/**
 * Checkpoint creation script
 * Creates checkpoints with session history and artifact snapshot (Git or VM0)
 */
export const CREATE_CHECKPOINT_SCRIPT = `# Create checkpoint after successful run
# Requires: COMMON_SCRIPT, GIT_SNAPSHOT_SCRIPT, VM0_SNAPSHOT_SCRIPT to be sourced first

create_checkpoint() {
  echo "[VM0] Creating checkpoint..." >&2

  # Read session ID from temp file
  if [ ! -f "$SESSION_ID_FILE" ]; then
    echo "[ERROR] No session ID found, checkpoint creation failed" >&2
    return 1
  fi
  local SESSION_ID=$(cat "$SESSION_ID_FILE")

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
  SESSION_HISTORY=$(cat "$SESSION_HISTORY_PATH" 2>/dev/null || echo "")
  if [ -z "$SESSION_HISTORY" ]; then
    echo "[ERROR] Session history is empty, checkpoint creation failed" >&2
    return 1
  fi

  echo "[VM0] Session history loaded ($(echo "$SESSION_HISTORY" | wc -l) lines)" >&2

  # Create artifact snapshot based on driver type
  ARTIFACT_SNAPSHOT="null"

  if [ -n "$ARTIFACT_DRIVER" ]; then
    echo "[VM0] Processing artifact with driver: $ARTIFACT_DRIVER" >&2

    if [ "$ARTIFACT_DRIVER" = "git" ]; then
      # Git artifact: create git snapshot
      echo "[VM0] Creating Git snapshot for artifact at $ARTIFACT_MOUNT_PATH" >&2

      # Create Git snapshot - redirect stderr to suppress git messages
      SNAPSHOT=$(create_git_snapshot "$ARTIFACT_MOUNT_PATH" "artifact" 2>/dev/null)

      if [ $? -eq 0 ] && [ -n "$SNAPSHOT" ]; then
        # Build artifact snapshot JSON
        local snap_tmp="/tmp/snap-$RUN_ID-artifact.json"
        echo "$SNAPSHOT" > "$snap_tmp"

        ARTIFACT_SNAPSHOT=$(jq -n \\
          --arg driver "git" \\
          --arg mountPath "$ARTIFACT_MOUNT_PATH" \\
          --slurpfile snap "$snap_tmp" \\
          '{driver: $driver, mountPath: $mountPath, snapshot: $snap[0]}')

        rm -f "$snap_tmp"
        echo "[VM0] Git artifact snapshot created" >&2
      else
        echo "[ERROR] Failed to create Git snapshot for artifact" >&2
        return 1
      fi

    elif [ "$ARTIFACT_DRIVER" = "vm0" ]; then
      # VM0 artifact: create vm0 snapshot
      echo "[VM0] Creating VM0 snapshot for artifact '$ARTIFACT_VOLUME_NAME' at $ARTIFACT_MOUNT_PATH" >&2

      # Create VM0 snapshot
      SNAPSHOT=$(create_vm0_snapshot "$ARTIFACT_MOUNT_PATH" "artifact" "$ARTIFACT_VOLUME_NAME")

      if [ $? -eq 0 ] && [ -n "$SNAPSHOT" ]; then
        # Build artifact snapshot JSON
        local snap_tmp="/tmp/snap-$RUN_ID-artifact.json"
        echo "$SNAPSHOT" > "$snap_tmp"

        ARTIFACT_SNAPSHOT=$(jq -n \\
          --arg driver "vm0" \\
          --arg mountPath "$ARTIFACT_MOUNT_PATH" \\
          --arg vm0VolumeName "$ARTIFACT_VOLUME_NAME" \\
          --slurpfile snap "$snap_tmp" \\
          '{driver: $driver, mountPath: $mountPath, vm0VolumeName: $vm0VolumeName, snapshot: $snap[0]}')

        rm -f "$snap_tmp"
        echo "[VM0] VM0 artifact snapshot created" >&2
      else
        echo "[ERROR] Failed to create VM0 snapshot for artifact" >&2
        return 1
      fi
    else
      echo "[ERROR] Unknown artifact driver: $ARTIFACT_DRIVER" >&2
      return 1
    fi
  else
    echo "[VM0] No artifact configured, skipping snapshot" >&2
  fi

  echo "[VM0] Calling checkpoint API..." >&2

  # Build checkpoint payload with single artifactSnapshot (or null)
  local checkpoint_payload=$(jq -n \\
    --arg rid "$RUN_ID" \\
    --arg sid "$SESSION_ID" \\
    --arg history "$SESSION_HISTORY" \\
    --argjson artifact "$ARTIFACT_SNAPSHOT" \\
    '{
      runId: $rid,
      sessionId: $sid,
      sessionHistory: $history,
      artifactSnapshot: $artifact
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
