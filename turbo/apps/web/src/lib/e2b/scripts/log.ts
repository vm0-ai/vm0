/**
 * Unified logging functions for agent scripts
 * Provides consistent log format across all sandbox scripts
 */
export const LOG_SCRIPT = `# Unified logging functions
# Format: [LEVEL] [sandbox:SCRIPT_NAME] message

# Default script name, can be overridden by sourcing script
LOG_SCRIPT_NAME="\${LOG_SCRIPT_NAME:-run-agent}"

log_info() {
  echo "[INFO] [sandbox:\${LOG_SCRIPT_NAME}] $*" >&2
}

log_warn() {
  echo "[WARN] [sandbox:\${LOG_SCRIPT_NAME}] $*" >&2
}

log_error() {
  echo "[ERROR] [sandbox:\${LOG_SCRIPT_NAME}] $*" >&2
}

log_debug() {
  if [ "$VM0_DEBUG" = "1" ]; then
    echo "[DEBUG] [sandbox:\${LOG_SCRIPT_NAME}] $*" >&2
  fi
}
`;
