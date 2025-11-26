/**
 * Common utilities and environment variables for agent scripts
 * This script is sourced by other scripts to share common functionality
 */
export const COMMON_SCRIPT = `# Common environment variables and utilities
# This script should be sourced by other scripts

# Get environment variables
RUN_ID="\${VM0_RUN_ID}"
API_URL="\${VM0_API_URL}"
API_TOKEN="\${VM0_API_TOKEN}"
PROMPT="\${VM0_PROMPT}"
WORKING_DIR="\${VM0_WORKING_DIR:-/home/user/workspace}"
VERCEL_BYPASS="\${VERCEL_PROTECTION_BYPASS:-}"
RESUME_SESSION_ID="\${VM0_RESUME_SESSION_ID:-}"

# Artifact configuration (replaces GIT_VOLUMES and VM0_VOLUMES)
ARTIFACT_DRIVER="\${VM0_ARTIFACT_DRIVER:-}"
ARTIFACT_MOUNT_PATH="\${VM0_ARTIFACT_MOUNT_PATH:-}"
ARTIFACT_VOLUME_NAME="\${VM0_ARTIFACT_VOLUME_NAME:-}"
ARTIFACT_VERSION_ID="\${VM0_ARTIFACT_VERSION_ID:-}"

# Construct webhook endpoint URLs
WEBHOOK_URL="\${API_URL}/api/webhooks/agent/events"
CHECKPOINT_URL="\${API_URL}/api/webhooks/agent/checkpoints"
STORAGE_WEBHOOK_URL="\${API_URL}/api/webhooks/agent/storages"

# Variables for checkpoint (use temp files to persist across subshells)
SESSION_ID_FILE="/tmp/vm0-session-$RUN_ID.txt"
SESSION_HISTORY_PATH_FILE="/tmp/vm0-session-history-$RUN_ID.txt"
`;
