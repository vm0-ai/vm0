/**
 * Unified logging module for VM0 agent scripts.
 * Provides consistent log format with timestamps.
 * Format: [TIMESTAMP] [LEVEL] [sandbox:SCRIPT_NAME] message
 */

// Default script name, can be overridden by setting LOG_SCRIPT_NAME env var
const SCRIPT_NAME = process.env.LOG_SCRIPT_NAME ?? "run-agent";

function getTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function logInfo(msg: string): void {
  console.error(`[${getTimestamp()}] [INFO] [sandbox:${SCRIPT_NAME}] ${msg}`);
}

export function logWarn(msg: string): void {
  console.error(`[${getTimestamp()}] [WARN] [sandbox:${SCRIPT_NAME}] ${msg}`);
}

export function logError(msg: string): void {
  console.error(`[${getTimestamp()}] [ERROR] [sandbox:${SCRIPT_NAME}] ${msg}`);
}

export function logDebug(msg: string): void {
  if (process.env.VM0_DEBUG === "1") {
    console.error(
      `[${getTimestamp()}] [DEBUG] [sandbox:${SCRIPT_NAME}] ${msg}`,
    );
  }
}
