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
WORKING_DIR="\${VM0_WORKING_DIR:-/home/user}"
VERCEL_BYPASS="\${VERCEL_PROTECTION_BYPASS:-}"
GIT_VOLUMES="\${VM0_GIT_VOLUMES:-[]}"
VM0_VOLUMES="\${VM0_VM0_VOLUMES:-[]}"
RESUME_SESSION_ID="\${VM0_RESUME_SESSION_ID:-}"

# Construct webhook endpoint URLs
WEBHOOK_URL="\${API_URL}/api/webhooks/agent/events"
CHECKPOINT_URL="\${API_URL}/api/webhooks/agent/checkpoints"
VOLUME_WEBHOOK_URL="\${API_URL}/api/webhooks/agent/volumes"

# Variables for checkpoint (use temp files to persist across subshells)
SESSION_ID_FILE="/tmp/vm0-session-$RUN_ID.txt"
SESSION_HISTORY_PATH_FILE="/tmp/vm0-session-history-$RUN_ID.txt"
`;
