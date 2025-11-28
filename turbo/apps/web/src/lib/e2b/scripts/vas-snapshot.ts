/**
 * VAS (Versioned Artifact Storage) snapshot script
 * Creates snapshots by uploading storage contents to the storage webhook API
 */
export const VAS_SNAPSHOT_SCRIPT = `# Create VAS snapshot for a storage
# Creates a zip of the storage contents and uploads to the storage webhook API
# Requires: COMMON_SCRIPT, LOG_SCRIPT, REQUEST_SCRIPT to be sourced first

create_vas_snapshot() {
  local mount_path="$1"
  local storage_name="$2"
  local vas_storage_name="$3"

  log_info "Creating VAS snapshot for storage '$storage_name' ($vas_storage_name) at $mount_path"
  log_debug "STORAGE_WEBHOOK_URL: $STORAGE_WEBHOOK_URL"
  log_debug "API_TOKEN length: \${#API_TOKEN}"
  log_debug "RUN_ID: $RUN_ID"

  # Create temp directory for zip
  local zip_dir="/tmp/vas-snapshot-$RUN_ID-$storage_name"
  mkdir -p "$zip_dir"
  local zip_path="$zip_dir/storage.zip"

  # Create zip of storage contents
  cd "$mount_path" || {
    log_error "Failed to cd to $mount_path"
    return 1
  }

  # Create zip file (exclude .git and .vas directories)
  # Try 'zip' command first, fallback to 'python3' zipfile module
  if command -v zip >/dev/null 2>&1; then
    if ! zip -r "$zip_path" . -x "*.git*" -x "*.vas*" >/dev/null 2>&1; then
      log_error "Failed to create zip for storage '$storage_name'"
      rm -rf "$zip_dir"
      return 1
    fi
  else
    # Fallback: use Python's zipfile module (always available with Claude Code)
    log_info "'zip' not found, using Python zipfile"
    python3 -c "
import zipfile
import os
with zipfile.ZipFile('$zip_path', 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk('.'):
        # Exclude .git and .vas directories
        dirs[:] = [d for d in dirs if d not in ['.git', '.vas']]
        for file in files:
            filepath = os.path.join(root, file)
            arcname = os.path.relpath(filepath, '.')
            zf.write(filepath, arcname)
" 2>&1 || {
      log_error "Failed to create zip using Python for storage '$storage_name'"
      rm -rf "$zip_dir"
      return 1
    }
  fi

  log_info "Created zip file for storage '$storage_name'"

  # Upload to storage webhook API using unified HTTP request function
  local response
  response=$(http_post_form "$STORAGE_WEBHOOK_URL" "$HTTP_MAX_RETRIES" \\
    -F "runId=$RUN_ID" \\
    -F "storageName=$vas_storage_name" \\
    -F "message=Checkpoint from run $RUN_ID" \\
    -F "file=@$zip_path")
  local http_exit=$?

  # Cleanup temp files
  rm -rf "$zip_dir"

  # Check HTTP request result
  if [ $http_exit -ne 0 ]; then
    log_error "Failed to upload snapshot for storage '$storage_name'"
    return 1
  fi

  # Check if response is valid JSON and extract versionId
  local version_id=$(echo "$response" | jq -r '.versionId // empty' 2>/dev/null)
  if [ -z "$version_id" ]; then
    log_error "Failed to create VAS snapshot for '$storage_name'"
    log_error "Webhook URL: $STORAGE_WEBHOOK_URL"
    log_error "Response: $response"
    return 1
  fi

  log_info "VAS snapshot created for '$storage_name': version $version_id"

  # Return JSON snapshot
  jq -n --arg vid "$version_id" '{versionId: $vid}'
  return 0
}
`;
