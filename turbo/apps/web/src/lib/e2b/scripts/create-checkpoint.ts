/**
 * Checkpoint creation script
 * Creates checkpoints with session history and volume snapshots (Git and VM0)
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

  # Create VM0 snapshots for each VM0 volume
  echo "[VM0] VM0_VOLUMES value: $VM0_VOLUMES" >&2
  if [ "$VM0_VOLUMES" != "[]" ]; then
    echo "[VM0] Processing $(echo "$VM0_VOLUMES" | jq 'length') VM0 volume(s)..." >&2

    # Initialize snapshots array if not already done
    if [ -z "$VOLUME_SNAPSHOTS" ] || [ "$VOLUME_SNAPSHOTS" = "[]" ]; then
      local snapshots_array="[]"
    else
      local snapshots_array="$VOLUME_SNAPSHOTS"
    fi

    while IFS= read -r volume; do
      VOLUME_NAME=$(echo "$volume" | jq -r '.name')
      MOUNT_PATH=$(echo "$volume" | jq -r '.mountPath')
      VM0_VOLUME_NAME=$(echo "$volume" | jq -r '.vm0VolumeName')

      # Create VM0 snapshot
      SNAPSHOT=$(create_vm0_snapshot "$MOUNT_PATH" "$VOLUME_NAME" "$VM0_VOLUME_NAME")

      if [ $? -eq 0 ] && [ -n "$SNAPSHOT" ]; then
        # Build VM0 volume snapshot object
        local vol_tmp="/tmp/vol-$RUN_ID-$VOLUME_NAME.json"
        local snap_tmp="/tmp/snap-$RUN_ID-$VOLUME_NAME.json"
        local arr_tmp="/tmp/arr-$RUN_ID.json"

        # Create volume snapshot object with vm0VolumeName
        jq -n \\
          --arg name "$VOLUME_NAME" \\
          --arg driver "vm0" \\
          --arg mountPath "$MOUNT_PATH" \\
          --arg vm0VolumeName "$VM0_VOLUME_NAME" \\
          '{name: $name, driver: $driver, mountPath: $mountPath, vm0VolumeName: $vm0VolumeName}' > "$vol_tmp"

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

        echo "[VM0] VM0 snapshot created for '$VOLUME_NAME'" >&2
      else
        echo "[ERROR] Failed to create VM0 snapshot for '$VOLUME_NAME'" >&2
        return 1
      fi
    done < <(echo "$VM0_VOLUMES" | jq -c '.[]')

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
