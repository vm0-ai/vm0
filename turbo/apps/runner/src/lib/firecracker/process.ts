/**
 * Firecracker Process Discovery
 *
 * Utilities for finding and managing Firecracker and mitmproxy processes.
 * Used by maintenance CLI commands (doctor, kill) to discover running VMs.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import { type VmId, createVmId, vmIdValue } from "./vm-id.js";
import { isProcessRunning } from "../utils/process.js";

interface FirecrackerProcess {
  pid: number;
  vmId: VmId;
}

/**
 * Parse /proc/{pid}/cmdline content to extract Firecracker process info.
 * Pure function for easy testing.
 *
 * Supports two modes:
 * - Snapshot restore: --api-sock /path/to/vm0-{vmId}/api.sock
 * - Fresh boot: --config-file /path/to/vm0-{vmId}/config.json
 */
export function parseFirecrackerCmdline(cmdline: string): VmId | null {
  const args = cmdline.split("\0");

  if (!args[0]?.includes("firecracker")) return null;

  // Try --api-sock first (snapshot restore mode)
  let filePath: string | undefined;
  const sockIdx = args.indexOf("--api-sock");
  if (sockIdx !== -1) {
    filePath = args[sockIdx + 1];
  }

  // Try --config-file (fresh boot mode)
  if (!filePath) {
    const configIdx = args.indexOf("--config-file");
    if (configIdx !== -1) {
      filePath = args[configIdx + 1];
    }
  }

  if (!filePath) return null;

  // Extract vmId from path: .../vm0-{vmId}/...
  const match = filePath.match(/vm0-([a-f0-9]+)\//);
  if (!match?.[1]) return null;

  return createVmId(match[1]);
}

/**
 * Parse /proc/{pid}/cmdline content to extract mitmproxy registry path.
 * Pure function for easy testing.
 *
 * Returns registryPath from --set vm0_registry_path=xxx (unique per runner)
 */
export function parseMitmproxyCmdline(cmdline: string): string | null {
  if (!cmdline.includes("mitmproxy") && !cmdline.includes("mitmdump")) {
    return null;
  }

  const args = cmdline.split("\0");

  // Parse --set vm0_registry_path=xxx (unique per runner)
  for (const arg of args) {
    const match = arg.match(/^vm0_registry_path=(.+)$/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
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
      const vmId = parseFirecrackerCmdline(cmdline);
      if (vmId) {
        processes.push({ pid, vmId });
      }
    } catch {
      continue;
    }
  }

  return processes;
}

/**
 * Find a specific Firecracker process by vmId
 */
export function findProcessByVmId(vmId: VmId): FirecrackerProcess | null {
  const processes = findFirecrackerProcesses();
  const vmIdStr = vmIdValue(vmId);
  return processes.find((p) => vmIdValue(p.vmId) === vmIdStr) || null;
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

interface MitmproxyProcess {
  pid: number;
  registryPath: string;
}

/**
 * Find all mitmproxy processes
 */
export function findMitmproxyProcesses(): MitmproxyProcess[] {
  const processes: MitmproxyProcess[] = [];
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
      const registryPath = parseMitmproxyCmdline(cmdline);
      if (registryPath) {
        processes.push({ pid, registryPath });
      }
    } catch {
      continue;
    }
  }

  return processes;
}
