/**
 * VAS (Versioned Artifact Storage) snapshot script
 * Creates snapshots by uploading storage contents to the storage webhook API
 */
export const VAS_SNAPSHOT_SCRIPT = `# Create VAS snapshot for a storage
# Creates a tar.gz of the storage contents and uploads to the storage webhook API
# Requires: COMMON_SCRIPT, LOG_SCRIPT, REQUEST_SCRIPT to be sourced first

create_vas_snapshot() {
  local mount_path="$1"
  local storage_name="$2"
  local vas_storage_name="$3"

  log_info "Creating VAS snapshot for storage '$storage_name' ($vas_storage_name) at $mount_path"
  log_debug "STORAGE_WEBHOOK_URL: $STORAGE_WEBHOOK_URL"
  log_debug "API_TOKEN length: \${#API_TOKEN}"
  log_debug "RUN_ID: $RUN_ID"

  # Create temp directory for tar.gz
  local tar_dir="/tmp/vas-snapshot-$RUN_ID-$storage_name"
  mkdir -p "$tar_dir"
  local tar_path="$tar_dir/storage.tar.gz"

  # Create tar.gz of storage contents
  cd "$mount_path" || {
    log_error "Failed to cd to $mount_path"
    return 1
  }

  # Create tar.gz file (exclude .git and .vas directories)
  if ! tar -czf "$tar_path" --exclude='.git' --exclude='.vas' . 2>/dev/null; then
    log_error "Failed to create tar.gz for storage '$storage_name'"
    rm -rf "$tar_dir"
    return 1
  fi

  log_info "Created tar.gz file for storage '$storage_name'"

  # Upload to storage webhook API using unified HTTP request function
  local response
  response=$(http_post_form "$STORAGE_WEBHOOK_URL" "$HTTP_MAX_RETRIES" \\
    -F "runId=$RUN_ID" \\
    -F "storageName=$vas_storage_name" \\
    -F "message=Checkpoint from run $RUN_ID" \\
    -F "file=@$tar_path")
  local http_exit=$?

  # Cleanup temp files
  rm -rf "$tar_dir"

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
