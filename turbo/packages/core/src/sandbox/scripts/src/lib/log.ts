/**
 * Unified logging module for VM0 agent scripts.
 * Provides consistent log format with timestamps.
 */

const SCRIPT_NAME = "sandbox";

function getTimestamp(): string {
  return new Date().toISOString();
}

export function logInfo(msg: string): void {
  console.error(`[${getTimestamp()}] [INFO] [${SCRIPT_NAME}] ${msg}`);
}

export function logWarn(msg: string): void {
  console.error(`[${getTimestamp()}] [WARN] [${SCRIPT_NAME}] ${msg}`);
}

export function logError(msg: string): void {
  console.error(`[${getTimestamp()}] [ERROR] [${SCRIPT_NAME}] ${msg}`);
}

export function logDebug(msg: string): void {
  if (process.env.VM0_DEBUG === "1") {
    console.error(`[${getTimestamp()}] [DEBUG] [${SCRIPT_NAME}] ${msg}`);
  }
}
