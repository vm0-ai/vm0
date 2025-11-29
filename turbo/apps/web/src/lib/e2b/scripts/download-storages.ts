/**
 * Download storages script for E2B sandbox
 * Downloads files directly from S3 using presigned URLs
 *
 * This script is uploaded to the sandbox and executed to download
 * storage files directly from S3, bypassing the VM0 server.
 */

// Use template literal to inject $ signs without escaping
const dollar = "$";

export const DOWNLOAD_STORAGES_SCRIPT = `#!/bin/bash
# Download storages from S3 using presigned URLs
# Usage: download-storages.sh <manifest_path>
# Requires: curl, jq

set -e

MANIFEST_PATH="${dollar}1"
MAX_PARALLEL=${dollar}{VM0_DOWNLOAD_PARALLEL:-10}

# Source common utilities
source /usr/local/bin/vm0-agent/lib/common.sh
source /usr/local/bin/vm0-agent/lib/log.sh

if [ -z "${dollar}MANIFEST_PATH" ] || [ ! -f "${dollar}MANIFEST_PATH" ]; then
  log_error "Manifest file not found: ${dollar}MANIFEST_PATH"
  exit 1
fi

log_info "Starting storage download from manifest: ${dollar}MANIFEST_PATH"

# Create temp files for tracking
DOWNLOAD_TASKS=${dollar}(mktemp)
DOWNLOAD_ERRORS=${dollar}(mktemp)
trap "rm -f ${dollar}DOWNLOAD_TASKS ${dollar}DOWNLOAD_ERRORS" EXIT

# Parse manifest and generate download tasks for storages
# Format: <local_path>\\t<url>\\t<expected_size>
jq -r '
  (.storages // [])[] | .mountPath as ${dollar}mount |
    .files[] | "\\(${dollar}mount)/\\(.path)\\t\\(.url)\\t\\(.size)"
' "${dollar}MANIFEST_PATH" >> "${dollar}DOWNLOAD_TASKS"

# Add artifact files if present
jq -r '
  .artifact // empty | .mountPath as ${dollar}mount |
    .files[] | "\\(${dollar}mount)/\\(.path)\\t\\(.url)\\t\\(.size)"
' "${dollar}MANIFEST_PATH" >> "${dollar}DOWNLOAD_TASKS"

TOTAL_FILES=${dollar}(wc -l < "${dollar}DOWNLOAD_TASKS" | tr -d ' ')
log_info "Found ${dollar}TOTAL_FILES files to download"

if [ "${dollar}TOTAL_FILES" -eq 0 ]; then
  log_info "No files to download"
  exit 0
fi

# Create all directories first
cut -f1 "${dollar}DOWNLOAD_TASKS" | xargs -I{} dirname {} | sort -u | while read dir; do
  mkdir -p "${dollar}dir"
done

# Download function for parallel execution
download_file() {
  local line="${dollar}1"
  local path=${dollar}(echo "${dollar}line" | cut -f1)
  local url=${dollar}(echo "${dollar}line" | cut -f2)
  local expected_size=${dollar}(echo "${dollar}line" | cut -f3)

  # Download with retry
  local attempt=1
  local max_attempts=3

  while [ ${dollar}attempt -le ${dollar}max_attempts ]; do
    if curl -fsSL -o "${dollar}path" "${dollar}url" 2>/dev/null; then
      # Verify file size if provided and not empty
      if [ -n "${dollar}expected_size" ] && [ "${dollar}expected_size" != "null" ] && [ "${dollar}expected_size" != "0" ]; then
        local actual_size=${dollar}(stat -c%s "${dollar}path" 2>/dev/null || stat -f%z "${dollar}path" 2>/dev/null)
        if [ "${dollar}actual_size" != "${dollar}expected_size" ]; then
          echo "Size mismatch for ${dollar}path: expected ${dollar}expected_size, got ${dollar}actual_size" >> "${dollar}DOWNLOAD_ERRORS"
          return 1
        fi
      fi
      return 0
    fi

    attempt=${dollar}((attempt + 1))
    [ ${dollar}attempt -le ${dollar}max_attempts ] && sleep 1
  done

  echo "Failed to download ${dollar}path after ${dollar}max_attempts attempts" >> "${dollar}DOWNLOAD_ERRORS"
  return 1
}

export -f download_file
export DOWNLOAD_ERRORS

# Execute downloads in parallel using xargs
log_info "Downloading files with ${dollar}MAX_PARALLEL parallel connections..."

cat "${dollar}DOWNLOAD_TASKS" | xargs -P "${dollar}MAX_PARALLEL" -I{} bash -c 'download_file "${dollar}@"' _ {}

# Check for errors
if [ -s "${dollar}DOWNLOAD_ERRORS" ]; then
  log_error "Some downloads failed:"
  cat "${dollar}DOWNLOAD_ERRORS" >&2
  exit 1
fi

log_info "Successfully downloaded ${dollar}TOTAL_FILES files"
`;
