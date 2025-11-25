/**
 * VM0 volume snapshot script
 * Creates snapshots by uploading volume contents to the volume webhook API
 */
export const VM0_SNAPSHOT_SCRIPT = `# Create VM0 snapshot for a volume
# Creates a zip of the volume contents and uploads to the volume webhook API
# Requires: COMMON_SCRIPT to be sourced first

create_vm0_snapshot() {
  local mount_path="$1"
  local volume_name="$2"
  local vm0_volume_name="$3"

  echo "[VM0] Creating VM0 snapshot for volume '$volume_name' ($vm0_volume_name) at $mount_path" >&2
  echo "[VM0] VOLUME_WEBHOOK_URL: $VOLUME_WEBHOOK_URL" >&2
  echo "[VM0] API_TOKEN length: \${#API_TOKEN}" >&2
  echo "[VM0] RUN_ID: $RUN_ID" >&2

  # Create temp directory for zip
  local zip_dir="/tmp/vm0-snapshot-$RUN_ID-$volume_name"
  mkdir -p "$zip_dir"
  local zip_path="$zip_dir/volume.zip"

  # Create zip of volume contents
  cd "$mount_path" || {
    echo "[ERROR] Failed to cd to $mount_path" >&2
    return 1
  }

  # Create zip file (exclude .git and .vm0 directories)
  # Try 'zip' command first, fallback to 'python3' zipfile module
  if command -v zip >/dev/null 2>&1; then
    if ! zip -r "$zip_path" . -x "*.git*" -x "*.vm0*" >/dev/null 2>&1; then
      echo "[ERROR] Failed to create zip for volume '$volume_name'" >&2
      rm -rf "$zip_dir"
      return 1
    fi
  else
    # Fallback: use Python's zipfile module (always available with Claude Code)
    echo "[VM0] 'zip' not found, using Python zipfile" >&2
    python3 -c "
import zipfile
import os
with zipfile.ZipFile('$zip_path', 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk('.'):
        # Exclude .git and .vm0 directories
        dirs[:] = [d for d in dirs if d not in ['.git', '.vm0']]
        for file in files:
            filepath = os.path.join(root, file)
            arcname = os.path.relpath(filepath, '.')
            zf.write(filepath, arcname)
" 2>&1 || {
      echo "[ERROR] Failed to create zip using Python for volume '$volume_name'" >&2
      rm -rf "$zip_dir"
      return 1
    }
  fi

  echo "[VM0] Created zip file for volume '$volume_name'" >&2

  # Upload to volume webhook API (with timeout to prevent hanging)
  local response
  if [ -n "$VERCEL_BYPASS" ]; then
    response=$(curl -X POST "$VOLUME_WEBHOOK_URL" \\
      -H "Authorization: Bearer $API_TOKEN" \\
      -H "x-vercel-protection-bypass: $VERCEL_BYPASS" \\
      -F "runId=$RUN_ID" \\
      -F "volumeName=$vm0_volume_name" \\
      -F "message=Checkpoint from run $RUN_ID" \\
      -F "file=@$zip_path" \\
      --connect-timeout 10 \\
      --max-time 60 \\
      --silent 2>&1)
  else
    response=$(curl -X POST "$VOLUME_WEBHOOK_URL" \\
      -H "Authorization: Bearer $API_TOKEN" \\
      -F "runId=$RUN_ID" \\
      -F "volumeName=$vm0_volume_name" \\
      -F "message=Checkpoint from run $RUN_ID" \\
      -F "file=@$zip_path" \\
      --connect-timeout 10 \\
      --max-time 60 \\
      --silent 2>&1)
  fi
  local curl_exit=$?

  # Cleanup temp files
  rm -rf "$zip_dir"

  # Check curl exit code
  if [ $curl_exit -ne 0 ]; then
    echo "[ERROR] curl failed with exit code $curl_exit for volume '$volume_name'" >&2
    echo "[ERROR] Response: $response" >&2
    return 1
  fi

  # Check if response is valid JSON and extract versionId
  local version_id=$(echo "$response" | jq -r '.versionId // empty' 2>/dev/null)
  if [ -z "$version_id" ]; then
    echo "[ERROR] Failed to create VM0 snapshot for '$volume_name'" >&2
    echo "[ERROR] Webhook URL: $VOLUME_WEBHOOK_URL" >&2
    echo "[ERROR] Response: $response" >&2
    return 1
  fi

  echo "[VM0] VM0 snapshot created for '$volume_name': version $version_id" >&2

  # Return JSON snapshot
  jq -n --arg vid "$version_id" '{versionId: $vid}'
  return 0
}
`;
