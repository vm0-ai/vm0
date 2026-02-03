/**
 * Runner Lock - ensures only one runner per device
 *
 * Uses a PID file to prevent multiple runner instances
 * from running on the same device.
 */

import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../logger.js";
import { runtimePaths } from "../paths.js";

const logger = createLogger("RunnerLock");

const DEFAULT_PID_FILE = runtimePaths.runnerPid;

// Module state for tracking current lock
let currentPidFile: string | null = null;

interface RunnerLockOptions {
  /** Custom PID file path (for testing). Defaults to /var/run/vm0/runner.pid */
  pidFile?: string;
}

/**
 * Check if a process is running
 *
 * Uses kill(pid, 0) which checks process existence without sending a signal.
 * - Returns true if process exists (signal would be deliverable)
 * - Returns true if EPERM (process exists but we lack permission)
 * - Returns false if ESRCH (no such process)
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means process exists but we don't have permission to signal it
    if (err instanceof Error && "code" in err && err.code === "EPERM") {
      return true;
    }
    // ESRCH or other errors mean process doesn't exist
    return false;
  }
}

/**
 * Acquire runner lock - exits if another runner is running
 */
export function acquireRunnerLock(options: RunnerLockOptions = {}): void {
  const pidFile = options.pidFile ?? DEFAULT_PID_FILE;
  const runDir = path.dirname(pidFile);
  fs.mkdirSync(runDir, { recursive: true });

  if (fs.existsSync(pidFile)) {
    const pidStr = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);

    if (!isNaN(pid) && isProcessRunning(pid)) {
      logger.error(`Error: Another runner is already running (PID ${pid})`);
      logger.error(`If this is incorrect, remove ${pidFile} and try again.`);
      process.exit(1);
    }

    // Stale PID file - clean up
    if (isNaN(pid)) {
      logger.log("Cleaning up invalid PID file");
    } else {
      logger.log(`Cleaning up stale PID file (PID ${pid} not running)`);
    }
    fs.unlinkSync(pidFile);
  }

  // Write current PID
  fs.writeFileSync(pidFile, process.pid.toString());
  currentPidFile = pidFile;
  logger.log(`Runner lock acquired (PID ${process.pid})`);
}

/**
 * Release runner lock
 */
export function releaseRunnerLock(): void {
  const pidFile = currentPidFile ?? DEFAULT_PID_FILE;
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
    logger.log("Runner lock released");
  }
  currentPidFile = null;
}
