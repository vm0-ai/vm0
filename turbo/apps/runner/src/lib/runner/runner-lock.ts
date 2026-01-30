/**
 * Runner Lock - ensures only one runner per device
 *
 * Uses a PID file at /var/run/vm0/runner.pid to prevent multiple
 * runner instances from running on the same device.
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const VM0_RUN_DIR = "/var/run/vm0";
const PID_FILE = `${VM0_RUN_DIR}/runner.pid`;

/**
 * Ensure the vm0 run directory exists
 */
async function ensureRunDir(): Promise<void> {
  if (!fs.existsSync(VM0_RUN_DIR)) {
    await execAsync(`sudo mkdir -p ${VM0_RUN_DIR}`);
    await execAsync(`sudo chmod 777 ${VM0_RUN_DIR}`);
  }
}

/**
 * Check if a process is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire runner lock - exits if another runner is running
 */
export async function acquireRunnerLock(): Promise<void> {
  await ensureRunDir();

  if (fs.existsSync(PID_FILE)) {
    const pidStr = fs.readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(pidStr, 10);

    if (!isNaN(pid) && isProcessRunning(pid)) {
      console.error(`Error: Another runner is already running (PID ${pid})`);
      console.error(`If this is incorrect, remove ${PID_FILE} and try again.`);
      process.exit(1);
    }

    // Stale PID file - clean up
    console.log(`Cleaning up stale PID file (PID ${pid} not running)`);
    fs.unlinkSync(PID_FILE);
  }

  // Write current PID
  fs.writeFileSync(PID_FILE, process.pid.toString());
  console.log(`Runner lock acquired (PID ${process.pid})`);
}

/**
 * Release runner lock
 */
export function releaseRunnerLock(): void {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
    console.log("Runner lock released");
  }
}
