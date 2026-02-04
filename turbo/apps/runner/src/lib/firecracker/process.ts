/**
 * Firecracker Process Discovery
 *
 * Utilities for finding and managing Firecracker and mitmproxy processes.
 * Used by maintenance CLI commands (doctor, kill) to discover running VMs.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import { type VmId, createVmId, vmIdValue } from "./vm-id.js";

export interface FirecrackerProcess {
  pid: number;
  vmId: VmId;
  baseDir: string;
}

/**
 * Parse /proc/{pid}/cmdline content to extract Firecracker process info.
 * Pure function for easy testing.
 *
 * Supports two modes:
 * - Snapshot restore: --api-sock /path/to/vm0-{vmId}/api.sock
 * - Fresh boot: --config-file /path/to/vm0-{vmId}/config.json
 *
 * Returns vmId and baseDir (runner's base directory)
 */
export function parseFirecrackerCmdline(
  cmdline: string,
): { vmId: VmId; baseDir: string } | null {
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
  const vmIdMatch = filePath.match(/vm0-([a-f0-9]+)\//);
  if (!vmIdMatch?.[1]) return null;

  // Extract baseDir: everything before /workspaces/
  const baseDirMatch = filePath.match(/^(.+)\/workspaces\/vm0-[a-f0-9]+\//);
  if (!baseDirMatch?.[1]) return null;

  return { vmId: createVmId(vmIdMatch[1]), baseDir: baseDirMatch[1] };
}

/**
 * Parse /proc/{pid}/cmdline content to extract mitmproxy base directory.
 * Pure function for easy testing.
 *
 * Extracts baseDir from --set vm0_registry_path={baseDir}/vm-registry.json
 */
export function parseMitmproxyCmdline(cmdline: string): string | null {
  if (!cmdline.includes("mitmproxy") && !cmdline.includes("mitmdump")) {
    return null;
  }

  const args = cmdline.split("\0");

  // Parse --set vm0_registry_path=xxx (unique per runner)
  for (const arg of args) {
    const match = arg.match(/^vm0_registry_path=(.+)\/vm-registry\.json$/);
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
      const parsed = parseFirecrackerCmdline(cmdline);
      if (parsed) {
        processes.push({ pid, vmId: parsed.vmId, baseDir: parsed.baseDir });
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

interface MitmproxyProcess {
  pid: number;
  baseDir: string;
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
      const baseDir = parseMitmproxyCmdline(cmdline);
      if (baseDir) {
        processes.push({ pid, baseDir });
      }
    } catch {
      continue;
    }
  }

  return processes;
}
