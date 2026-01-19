/**
 * Firecracker Process Discovery
 *
 * Utilities for finding and managing Firecracker and mitmproxy processes.
 * Used by maintenance CLI commands (doctor, kill) to discover running VMs.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";

interface FirecrackerProcess {
  pid: number;
  vmId: string;
  socketPath: string;
}

/**
 * Find all running Firecracker processes by scanning /proc
 */
export function findFirecrackerProcesses(): FirecrackerProcess[] {
  const processes: FirecrackerProcess[] = [];
  const procDir = "/proc";

  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;

    const pid = parseInt(entry, 10);
    const cmdlinePath = path.join(procDir, entry, "cmdline");

    if (!existsSync(cmdlinePath)) continue;

    try {
      const cmdline = readFileSync(cmdlinePath, "utf-8");
      const args = cmdline.split("\0");

      if (!args[0]?.includes("firecracker")) continue;

      const sockIdx = args.indexOf("--api-sock");
      const socketPath = args[sockIdx + 1];
      if (sockIdx === -1 || !socketPath) continue;

      const match = socketPath.match(/vm0-([a-f0-9]+)\/firecracker\.sock$/);
      if (!match || !match[1]) continue;

      processes.push({ pid, vmId: match[1], socketPath });
    } catch {
      continue;
    }
  }

  return processes;
}

/**
 * Find a specific Firecracker process by vmId
 */
export function findProcessByVmId(vmId: string): FirecrackerProcess | null {
  const processes = findFirecrackerProcesses();
  return processes.find((p) => p.vmId === vmId) || null;
}

/**
 * Check if a process is still running
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
 * Kill a process with SIGTERM, wait, then SIGKILL if needed
 */
export async function killProcess(
  pid: number,
  timeoutMs: number = 5000,
): Promise<boolean> {
  if (!isProcessRunning(pid)) return true;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessRunning(pid);
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore - process may have exited
    }
  }

  return !isProcessRunning(pid);
}

/**
 * Find mitmproxy process
 */
export function findMitmproxyProcess(): { pid: number; port?: number } | null {
  const procDir = "/proc";

  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;

    const pid = parseInt(entry, 10);
    const cmdlinePath = path.join(procDir, entry, "cmdline");

    if (!existsSync(cmdlinePath)) continue;

    try {
      const cmdline = readFileSync(cmdlinePath, "utf-8");
      if (cmdline.includes("mitmproxy") || cmdline.includes("mitmdump")) {
        // Try to extract port from arguments
        const args = cmdline.split("\0");
        const portIdx = args.findIndex(
          (a) => a === "-p" || a === "--listen-port",
        );
        const portArg = args[portIdx + 1];
        const port =
          portIdx !== -1 && portArg ? parseInt(portArg, 10) : undefined;
        return { pid, port };
      }
    } catch {
      continue;
    }
  }

  return null;
}
