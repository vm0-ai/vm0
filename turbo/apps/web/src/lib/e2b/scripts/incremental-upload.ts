/**
 * Incremental upload script for VAS (Versioned Artifact Storage)
 * Computes manifest diff and uploads only changed files to reduce bandwidth
 */

// Use template literal to inject $ signs without escaping
const dollar = "$";

export const INCREMENTAL_UPLOAD_SCRIPT = `# Incremental upload for VAS storage
# Computes local manifest, diffs with base manifest, uploads only changed files
# Requires: COMMON_SCRIPT, LOG_SCRIPT, REQUEST_SCRIPT to be sourced first
#
# Environment variables:
#   INCREMENTAL_WEBHOOK_URL - URL for incremental upload endpoint
#   STORAGE_WEBHOOK_URL - URL for full upload endpoint (fallback)
#   API_TOKEN - Bearer token for authentication
#   RUN_ID - Current run ID
#
# Arguments:
#   $1 - mount_path: Path to the storage directory
#   $2 - storage_name: Display name of the storage
#   $3 - vas_storage_name: VAS storage name
#   $4 - base_version_id: Base version ID for diff (optional)
#   $5 - manifest_url: URL to download base manifest (optional)

# Compute SHA-256 hash for a file
compute_file_hash() {
  local file_path="${dollar}1"
  sha256sum "${dollar}file_path" | cut -d' ' -f1
}

# Compute local manifest for a directory
# Outputs JSON with files array: [{path, hash, size}, ...]
compute_local_manifest() {
  local dir_path="${dollar}1"
  local temp_manifest="/tmp/local-manifest-${dollar}${dollar}.json"

  cd "${dollar}dir_path" || return 1

  echo '{"files":[' > "${dollar}temp_manifest"
  local first=true

  # Find all files, excluding .git and .vas
  while IFS= read -r -d '' file; do
    local rel_path="${dollar}{file#./}"
    local hash=$(sha256sum "${dollar}file" | cut -d' ' -f1)
    local size=$(stat -c%s "${dollar}file" 2>/dev/null || stat -f%z "${dollar}file" 2>/dev/null)

    if [ "${dollar}first" = true ]; then
      first=false
    else
      echo ',' >> "${dollar}temp_manifest"
    fi

    # Use jq to properly escape the path
    jq -n --arg p "${dollar}rel_path" --arg h "${dollar}hash" --argjson s "${dollar}size" \\
      '{path: ${dollar}p, hash: ${dollar}h, size: ${dollar}s}' >> "${dollar}temp_manifest"
  done < <(find . -type f ! -path '*/.git/*' ! -path '*/.vas/*' -print0)

  echo ']}' >> "${dollar}temp_manifest"

  cat "${dollar}temp_manifest"
  rm -f "${dollar}temp_manifest"
}

# Diff two manifests and output changes
# Input: old_manifest_path new_manifest_path
# Output: JSON with added, modified, deleted arrays
diff_manifests() {
  local old_manifest="${dollar}1"
  local new_manifest="${dollar}2"

  OLD_MANIFEST="${dollar}old_manifest" NEW_MANIFEST="${dollar}new_manifest" python3 << 'PYTHON_EOF'
import json
import os

def load_manifest(path):
    with open(path, 'r') as f:
        data = json.load(f)
    return {f['path']: f for f in data.get('files', [])}

old_files = load_manifest(os.environ['OLD_MANIFEST'])
new_files = load_manifest(os.environ['NEW_MANIFEST'])

old_paths = set(old_files.keys())
new_paths = set(new_files.keys())

added = list(new_paths - old_paths)
deleted = list(old_paths - new_paths)
modified = []

for path in old_paths & new_paths:
    if old_files[path]['hash'] != new_files[path]['hash']:
        modified.append(path)

result = {
    'added': sorted(added),
    'modified': sorted(modified),
    'deleted': sorted(deleted)
}

print(json.dumps(result))
PYTHON_EOF
}

# Create tar.gz of only changed files
create_incremental_tar() {
  local mount_path="${dollar}1"
  local tar_path="${dollar}2"
  local changes_json="${dollar}3"

  cd "${dollar}mount_path" || return 1

  # Extract file lists from changes
  local added=$(echo "${dollar}changes_json" | jq -r '.added[]')
  local modified=$(echo "${dollar}changes_json" | jq -r '.modified[]')

  # Create file list with added and modified files
  local file_list="/tmp/incremental-files-${dollar}${dollar}.txt"
  echo "${dollar}added" > "${dollar}file_list"
  echo "${dollar}modified" >> "${dollar}file_list"

  # Remove empty lines
  sed -i '/^${dollar}/d' "${dollar}file_list" 2>/dev/null || sed -i '' '/^${dollar}/d' "${dollar}file_list"

  if [ ! -s "${dollar}file_list" ]; then
    # No files to add, create empty tar.gz
    tar -czf "${dollar}tar_path" --files-from=/dev/null 2>/dev/null || touch "${dollar}tar_path"
    rm -f "${dollar}file_list"
    return 0
  fi

  # Create tar.gz from file list
  tar -czf "${dollar}tar_path" -T "${dollar}file_list" 2>/dev/null

  rm -f "${dollar}file_list"
}

# Main incremental upload function
create_incremental_snapshot() {
  local mount_path="${dollar}1"
  local storage_name="${dollar}2"
  local vas_storage_name="${dollar}3"
  local base_version_id="${dollar}4"
  local manifest_url="${dollar}5"

  log_info "Attempting incremental upload for '$storage_name'"

  # If no base version or manifest URL, fall back to full upload
  if [ -z "${dollar}base_version_id" ] || [ -z "${dollar}manifest_url" ]; then
    log_info "No base version, falling back to full upload"
    create_vas_snapshot "${dollar}mount_path" "${dollar}storage_name" "${dollar}vas_storage_name"
    return ${dollar}?
  fi

  local temp_dir="/tmp/incremental-${dollar}RUN_ID-${dollar}storage_name"
  mkdir -p "${dollar}temp_dir"

  # Download base manifest
  log_info "Downloading base manifest..."
  local old_manifest="${dollar}temp_dir/old-manifest.json"
  if ! curl -fsSL -o "${dollar}old_manifest" "${dollar}manifest_url" 2>/dev/null; then
    log_warn "Failed to download base manifest, falling back to full upload"
    rm -rf "${dollar}temp_dir"
    create_vas_snapshot "${dollar}mount_path" "${dollar}storage_name" "${dollar}vas_storage_name"
    return ${dollar}?
  fi

  # Compute local manifest
  log_info "Computing local manifest..."
  local new_manifest="${dollar}temp_dir/new-manifest.json"
  compute_local_manifest "${dollar}mount_path" > "${dollar}new_manifest"

  # Compute diff
  log_info "Computing diff..."
  local changes_json=$(diff_manifests "${dollar}old_manifest" "${dollar}new_manifest")

  local added_count=$(echo "${dollar}changes_json" | jq '.added | length')
  local modified_count=$(echo "${dollar}changes_json" | jq '.modified | length')
  local deleted_count=$(echo "${dollar}changes_json" | jq '.deleted | length')

  log_info "Changes: +${dollar}added_count ~${dollar}modified_count -${dollar}deleted_count"

  # If no changes, skip upload
  if [ "${dollar}added_count" -eq 0 ] && [ "${dollar}modified_count" -eq 0 ] && [ "${dollar}deleted_count" -eq 0 ]; then
    log_info "No changes detected, skipping upload"
    rm -rf "${dollar}temp_dir"
    # Return the base version as current
    jq -n --arg vid "${dollar}base_version_id" '{versionId: ${dollar}vid, unchanged: true}'
    return 0
  fi

  # Create tar.gz of changed files
  local tar_path="${dollar}temp_dir/changes.tar.gz"
  create_incremental_tar "${dollar}mount_path" "${dollar}tar_path" "${dollar}changes_json"

  # Upload to incremental endpoint
  log_info "Uploading incremental changes..."
  local response
  response=$(http_post_form "${dollar}INCREMENTAL_WEBHOOK_URL" "${dollar}HTTP_MAX_RETRIES" \\
    -F "runId=${dollar}RUN_ID" \\
    -F "storageName=${dollar}vas_storage_name" \\
    -F "baseVersion=${dollar}base_version_id" \\
    -F "changes=${dollar}changes_json" \\
    -F "message=Incremental checkpoint from run ${dollar}RUN_ID" \\
    -F "file=@${dollar}tar_path")
  local http_exit=${dollar}?

  # Cleanup
  rm -rf "${dollar}temp_dir"

  if [ ${dollar}http_exit -ne 0 ]; then
    log_warn "Incremental upload failed, falling back to full upload"
    create_vas_snapshot "${dollar}mount_path" "${dollar}storage_name" "${dollar}vas_storage_name"
    return ${dollar}?
  fi

  # Check response
  local version_id=$(echo "${dollar}response" | jq -r '.versionId // empty' 2>/dev/null)
  if [ -z "${dollar}version_id" ]; then
    log_error "Invalid response from incremental upload"
    log_error "Response: ${dollar}response"
    return 1
  fi

  # Log incremental stats if available
  local stats=$(echo "${dollar}response" | jq -r '.incrementalStats // empty' 2>/dev/null)
  if [ -n "${dollar}stats" ]; then
    local bytes_uploaded=$(echo "${dollar}stats" | jq -r '.bytesUploaded // 0')
    log_info "Incremental upload complete: ${dollar}bytes_uploaded bytes uploaded"
  fi

  log_info "Incremental snapshot created: version ${dollar}version_id"
  jq -n --arg vid "${dollar}version_id" '{versionId: ${dollar}vid}'
  return 0
}
`;
