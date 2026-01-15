/**
 * Unified logging functions for VM0 agent scripts.
 * Format: [TIMESTAMP] [LEVEL] [sandbox:SCRIPT_NAME] message
 */

// Default script name, can be overridden by setting LOG_SCRIPT_NAME env var
const SCRIPT_NAME = process.env.LOG_SCRIPT_NAME ?? "run-agent";
const DEBUG_MODE = process.env.VM0_DEBUG === "1";

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function logInfo(msg: string): void {
  console.error(`[${timestamp()}] [INFO] [sandbox:${SCRIPT_NAME}] ${msg}`);
}

export function logWarn(msg: string): void {
  console.error(`[${timestamp()}] [WARN] [sandbox:${SCRIPT_NAME}] ${msg}`);
}

export function logError(msg: string): void {
  console.error(`[${timestamp()}] [ERROR] [sandbox:${SCRIPT_NAME}] ${msg}`);
}

export function logDebug(msg: string): void {
  if (DEBUG_MODE) {
    console.error(`[${timestamp()}] [DEBUG] [sandbox:${SCRIPT_NAME}] ${msg}`);
  }
}
