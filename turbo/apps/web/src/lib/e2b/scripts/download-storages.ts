/**
 * Download storages script for E2B sandbox
 * Downloads tar.gz archives directly from S3 using presigned URLs
 *
 * This script is uploaded to the sandbox and executed to download
 * storage archives directly from S3, bypassing the VM0 server.
 */

// Use template literal to inject $ signs without escaping
const dollar = "$";

export const DOWNLOAD_STORAGES_SCRIPT = `#!/bin/bash
# Download storages from S3 using presigned URLs (tar.gz archive mode)
# Usage: download-storages.sh <manifest_path>
# Requires: curl, jq, tar

set -e

MANIFEST_PATH="${dollar}1"

# Source common utilities
source /usr/local/bin/vm0-agent/lib/common.sh
source /usr/local/bin/vm0-agent/lib/log.sh

if [ -z "${dollar}MANIFEST_PATH" ] || [ ! -f "${dollar}MANIFEST_PATH" ]; then
  log_error "Manifest file not found: ${dollar}MANIFEST_PATH"
  exit 1
fi

log_info "Starting storage download from manifest: ${dollar}MANIFEST_PATH"

# Download and extract a single storage/artifact
download_storage() {
  local mount_path="${dollar}1"
  local archive_url="${dollar}2"
  local temp_tar="/tmp/storage-${dollar}(date +%s%N).tar.gz"

  log_info "Downloading storage to ${dollar}mount_path"

  # Download tar.gz with retry
  local attempt=1
  local max_attempts=3

  while [ ${dollar}attempt -le ${dollar}max_attempts ]; do
    if curl -fsSL -o "${dollar}temp_tar" "${dollar}archive_url" 2>/dev/null; then
      break
    fi
    attempt=${dollar}((attempt + 1))
    [ ${dollar}attempt -le ${dollar}max_attempts ] && sleep 1
  done

  if [ ! -f "${dollar}temp_tar" ]; then
    log_error "Failed to download archive for ${dollar}mount_path after ${dollar}max_attempts attempts"
    return 1
  fi

  # Extract to mount path (handle empty archive gracefully)
  mkdir -p "${dollar}mount_path"
  # tar handles empty archives gracefully
  tar -xzf "${dollar}temp_tar" -C "${dollar}mount_path" 2>/dev/null || true
  rm -f "${dollar}temp_tar"

  log_info "Successfully extracted to ${dollar}mount_path"
}

# Count total storages
STORAGE_COUNT=${dollar}(jq -r '(.storages // []) | length' "${dollar}MANIFEST_PATH")
HAS_ARTIFACT=${dollar}(jq -r '.artifact != null' "${dollar}MANIFEST_PATH")

log_info "Found ${dollar}STORAGE_COUNT storages, artifact: ${dollar}HAS_ARTIFACT"

# Process storages
jq -r '(.storages // [])[] | "\\(.mountPath)\\t\\(.archiveUrl)"' "${dollar}MANIFEST_PATH" | \\
  while IFS=${dollar}'\\t' read -r mount_path archive_url; do
    if [ -n "${dollar}archive_url" ] && [ "${dollar}archive_url" != "null" ]; then
      download_storage "${dollar}mount_path" "${dollar}archive_url"
    fi
  done

# Process artifact
artifact_mount=${dollar}(jq -r '.artifact.mountPath // empty' "${dollar}MANIFEST_PATH")
artifact_url=${dollar}(jq -r '.artifact.archiveUrl // empty' "${dollar}MANIFEST_PATH")
if [ -n "${dollar}artifact_url" ] && [ "${dollar}artifact_url" != "null" ]; then
  download_storage "${dollar}artifact_mount" "${dollar}artifact_url"
fi

log_info "All storages downloaded successfully"
`;
