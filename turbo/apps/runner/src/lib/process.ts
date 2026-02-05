/**
 * Process Discovery
 *
 * Utilities for finding runner, Firecracker, and mitmproxy processes.
 * Used by maintenance CLI commands (doctor, kill) to discover running processes.
 */

import { readdirSync, readFileSync, readlinkSync, existsSync } from "fs";
import path from "path";
import { type VmId, createVmId, vmIdValue } from "./firecracker/vm-id.js";

// ==================== Interfaces ====================

export interface FirecrackerProcess {
  pid: number;
  vmId: VmId;
  baseDir: string;
  isOrphan: boolean;
}

export interface MitmproxyProcess {
  pid: number;
  baseDir: string;
  isOrphan: boolean;
}

interface RunnerProcess {
  pid: number;
  configPath: string;
  mode: "start" | "benchmark";
}

// ==================== Helpers ====================

/**
 * Check if a process is orphan (adopted by init, PPID == 1)
 */
function isOrphanProcess(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // Format: pid (comm) state ppid ...
    // comm can contain ')' so find the last ')' to locate end of comm
    const lastParen = stat.lastIndexOf(")");
    if (lastParen === -1) return false;

    // After comm: " state ppid ..."
    const fields = stat
      .slice(lastParen + 1)
      .trim()
      .split(/\s+/);
    // fields[0] = state, fields[1] = ppid
    return fields[1] === "1";
  } catch {
    return false;
  }
}

// ==================== Cmdline Parsers ====================

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
 * Parse /proc/{pid}/cmdline content to extract runner process info.
 * Pure function for easy testing.
 *
 * Looks for: "start" or "benchmark" followed by "--config <path>.yaml"
 */
export function parseRunnerCmdline(
  cmdline: string,
): { configPath: string; mode: "start" | "benchmark" } | null {
  const args = cmdline.split("\0").filter((a) => a !== "");

  // Find mode (start or benchmark)
  const startIdx = args.indexOf("start");
  const benchmarkIdx = args.indexOf("benchmark");

  let mode: "start" | "benchmark";
  let modeIdx: number;

  if (startIdx !== -1 && (benchmarkIdx === -1 || startIdx < benchmarkIdx)) {
    mode = "start";
    modeIdx = startIdx;
  } else if (benchmarkIdx !== -1) {
    mode = "benchmark";
    modeIdx = benchmarkIdx;
  } else {
    return null;
  }

  // Find --config after mode
  const configIdx = args.indexOf("--config", modeIdx + 1);
  if (configIdx === -1 || configIdx >= args.length - 1) return null;

  const configPath = args[configIdx + 1];
  if (!configPath?.match(/\.ya?ml$/)) return null;

  return { configPath, mode };
}

// ==================== Process Finders ====================

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
        processes.push({
          pid,
          vmId: parsed.vmId,
          baseDir: parsed.baseDir,
          isOrphan: isOrphanProcess(pid),
        });
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
        processes.push({ pid, baseDir, isOrphan: isOrphanProcess(pid) });
      }
    } catch {
      continue;
    }
  }

  return processes;
}

/**
 * Check if cmdline looks like a node process running index.js
 */
function isNodeIndexJs(cmdline: string): boolean {
  const args = cmdline.split("\0").filter((a) => a !== "");
  if (args.length < 2) return false;

  // First arg should be node
  if (!args[0]?.includes("node")) return false;

  // Second arg should be index.js (with optional path)
  return args[1]?.endsWith("index.js") ?? false;
}

/**
 * Find all runner processes
 *
 * Detection strategies:
 * 1. Direct CLI: "start/benchmark --config xxx.yaml" in cmdline
 * 2. PM2 mode: "node index.js" with runner.yaml in cwd
 */
export function findRunnerProcesses(): RunnerProcess[] {
  const processes: RunnerProcess[] = [];
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

      // Strategy 1: Direct CLI mode (args in cmdline)
      const parsed = parseRunnerCmdline(cmdline);
      if (parsed) {
        processes.push({
          pid,
          configPath: parsed.configPath,
          mode: parsed.mode,
        });
        continue;
      }

      // Strategy 2: PM2 mode (node index.js, check cwd for runner.yaml)
      if (isNodeIndexJs(cmdline)) {
        const cwdPath = path.join(procDir, entry, "cwd");
        const cwd = readlinkSync(cwdPath);
        const configPath = path.join(cwd, "runner.yaml");
        if (existsSync(configPath)) {
          processes.push({
            pid,
            configPath,
            mode: "start", // Default to start mode (cannot determine from cmdline)
          });
        }
      }
    } catch {
      continue;
    }
  }

  return processes;
}
