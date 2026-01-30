/**
 * Runner Lock - ensures only one runner per device
 *
 * Uses a PID file at /var/run/vm0/runner.pid to prevent multiple
 * runner instances from running on the same device.
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_RUN_DIR = "/var/run/vm0";
const DEFAULT_PID_FILE = `${DEFAULT_RUN_DIR}/runner.pid`;

// Module state for tracking current lock
let currentPidFile: string | null = null;

interface RunnerLockOptions {
  /** Custom PID file path (for testing). Defaults to /var/run/vm0/runner.pid */
  pidFile?: string;
  /** Skip sudo for directory creation (for testing). Defaults to false */
  skipSudo?: boolean;
}

/**
 * Ensure the directory for PID file exists
 */
async function ensureRunDir(dirPath: string, skipSudo: boolean): Promise<void> {
  if (!fs.existsSync(dirPath)) {
    if (skipSudo) {
      fs.mkdirSync(dirPath, { recursive: true });
    } else {
      await execAsync(`sudo mkdir -p ${dirPath}`);
      await execAsync(`sudo chmod 777 ${dirPath}`);
    }
  }
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
export async function acquireRunnerLock(
  options: RunnerLockOptions = {},
): Promise<void> {
  const pidFile = options.pidFile ?? DEFAULT_PID_FILE;
  const skipSudo = options.skipSudo ?? false;
  const runDir = path.dirname(pidFile);

  await ensureRunDir(runDir, skipSudo);

  if (fs.existsSync(pidFile)) {
    const pidStr = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);

    if (!isNaN(pid) && isProcessRunning(pid)) {
      console.error(`Error: Another runner is already running (PID ${pid})`);
      console.error(`If this is incorrect, remove ${pidFile} and try again.`);
      process.exit(1);
    }

    // Stale PID file - clean up
    console.log(`Cleaning up stale PID file (PID ${pid} not running)`);
    fs.unlinkSync(pidFile);
  }

  // Write current PID
  fs.writeFileSync(pidFile, process.pid.toString());
  currentPidFile = pidFile;
  console.log(`Runner lock acquired (PID ${process.pid})`);
}

/**
 * Release runner lock
 */
export function releaseRunnerLock(): void {
  const pidFile = currentPidFile ?? DEFAULT_PID_FILE;
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
    console.log("Runner lock released");
  }
  currentPidFile = null;
}
