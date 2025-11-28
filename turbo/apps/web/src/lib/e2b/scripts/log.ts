/**
 * Unified logging functions for agent scripts
 * Provides consistent log format across all sandbox scripts
 */
export const LOG_SCRIPT = `# Unified logging functions
# Format: [VM0][LEVEL] message

log_info() {
  echo "[VM0][INFO] $*" >&2
}

log_warn() {
  echo "[VM0][WARN] $*" >&2
}

log_error() {
  echo "[VM0][ERROR] $*" >&2
}

log_debug() {
  if [ "$VM0_DEBUG" = "1" ]; then
    echo "[VM0][DEBUG] $*" >&2
  fi
}
`;
