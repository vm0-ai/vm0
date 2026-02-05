/**
 * Runner Doctor Command
 *
 * Comprehensive health check for all runners on the host, including:
 * - Auto-discovery of runner processes
 * - API connectivity
 * - Network status (proxy)
 * - Active jobs
 * - Warning detection (orphan resources)
 */

import { Command } from "commander";
import { existsSync, readFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { loadConfig, type RunnerConfig } from "../lib/config.js";
import { runnerPaths, runtimePaths } from "../lib/paths.js";
import { pollForJob } from "../lib/api.js";
import {
  findFirecrackerProcesses,
  findMitmproxyProcesses,
  findRunnerProcesses,
  type FirecrackerProcess,
  type MitmproxyProcess,
} from "../lib/process.js";
import { withFileLock } from "../lib/utils/file-lock.js";
import { isProcessRunning } from "../lib/utils/process.js";
import { NS_PREFIX, RegistrySchema } from "../lib/firecracker/netns-pool.js";
import { type VmId, createVmId } from "../lib/firecracker/vm-id.js";
import { type RunnerStatus, RunnerStatusSchema } from "../lib/runner/types.js";

interface JobInfo {
  runId: string;
  vmId: VmId;
  firecrackerPid?: number;
}

interface Warning {
  message: string;
}

interface DiscoveredRunner {
  pid: number;
  config: RunnerConfig;
  mode: "start" | "benchmark";
}

/**
 * Get runner status from status.json
 */
function getRunnerStatus(
  statusFilePath: string,
  warnings: Warning[],
): RunnerStatus | null {
  if (!existsSync(statusFilePath)) {
    return null;
  }

  try {
    return RunnerStatusSchema.parse(
      JSON.parse(readFileSync(statusFilePath, "utf-8")),
    );
  } catch {
    warnings.push({ message: "status.json exists but cannot be parsed" });
    return null;
  }
}

/**
 * Check API connectivity
 */
async function checkApiConnectivity(
  config: RunnerConfig,
  warnings: Warning[],
): Promise<boolean> {
  try {
    await pollForJob(config.server, config.group);
    return true;
  } catch (error) {
    warnings.push({
      message: `Cannot connect to API: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
    return false;
  }
}

/**
 * Build job info from status and processes
 */
function buildJobInfo(
  status: RunnerStatus | null,
  processes: FirecrackerProcess[],
  baseDir: string,
): { jobs: JobInfo[]; statusVmIds: Set<VmId> } {
  const jobs: JobInfo[] = [];
  const statusVmIds = new Set<VmId>();

  // Filter processes to this runner's baseDir
  const runnerProcesses = processes.filter((p) => p.baseDir === baseDir);

  if (status?.active_run_ids) {
    for (const runId of status.active_run_ids) {
      const vmId = createVmId(runId);
      statusVmIds.add(vmId);
      const proc = runnerProcesses.find((p) => p.vmId === vmId);

      jobs.push({
        runId,
        vmId,
        firecrackerPid: proc?.pid,
      });
    }
  }

  return { jobs, statusVmIds };
}

/**
 * Find orphan network namespaces (namespaces whose runner process is no longer running)
 */
async function findOrphanNetworkNamespaces(
  warnings: Warning[],
): Promise<string[]> {
  // List all vm0 network namespaces
  let allNamespaces: string[] = [];
  try {
    const output = execSync("ip netns list 2>/dev/null || true", {
      encoding: "utf-8",
    });
    allNamespaces = output
      .split("\n")
      .map((line) => line.split(" ")[0] ?? "")
      .filter((ns) => ns.startsWith(NS_PREFIX));
  } catch (err) {
    warnings.push({
      message: `Failed to list network namespaces: ${err instanceof Error ? err.message : "Unknown error"}`,
    });
    return [];
  }

  if (allNamespaces.length === 0) {
    return [];
  }

  // Read netns registry to check runner PIDs
  const registryPath = runtimePaths.netnsRegistry;
  if (!existsSync(registryPath)) {
    // No registry but namespaces exist - all are orphans
    return allNamespaces;
  }

  try {
    return await withFileLock(registryPath, async () => {
      const registry = RegistrySchema.parse(
        JSON.parse(readFileSync(registryPath, "utf-8")),
      );

      // Build set of namespaces belonging to alive runners
      const aliveNamespaces = new Set<string>();
      for (const [runnerIdx, runner] of Object.entries(registry.runners)) {
        if (isProcessRunning(runner.pid)) {
          for (const nsIdx of Object.keys(runner.namespaces)) {
            aliveNamespaces.add(`${NS_PREFIX}${runnerIdx}-${nsIdx}`);
          }
        }
      }

      // Find orphans
      const orphans: string[] = [];
      for (const ns of allNamespaces) {
        if (!aliveNamespaces.has(ns)) {
          orphans.push(ns);
        }
      }
      return orphans;
    });
  } catch (err) {
    warnings.push({
      message: `Failed to read netns registry: ${err instanceof Error ? err.message : "Unknown error"}`,
    });
    return [];
  }
}

/**
 * Detect orphan resources for a specific runner
 */
function detectRunnerOrphanResources(
  jobs: JobInfo[],
  allProcesses: FirecrackerProcess[],
  workspaces: string[],
  statusVmIds: Set<VmId>,
  baseDir: string,
  warnings: Warning[],
): void {
  // Filter processes to only include those belonging to this runner
  const processes = allProcesses.filter((p) => p.baseDir === baseDir);

  // Runs without process
  for (const job of jobs) {
    if (!job.firecrackerPid) {
      warnings.push({
        message: `Run ${job.vmId} in status.json but no Firecracker process`,
      });
    }
  }

  // Orphan processes (only for this runner)
  const processVmIds = new Set(processes.map((p) => p.vmId));
  for (const proc of processes) {
    if (!statusVmIds.has(proc.vmId)) {
      warnings.push({
        message: `Orphan process: PID ${proc.pid} (vmId ${proc.vmId}) not in status.json`,
      });
    }
  }

  // Orphan workspaces
  for (const ws of workspaces) {
    const vmId = runnerPaths.extractVmId(ws);
    if (!processVmIds.has(vmId) && !statusVmIds.has(vmId)) {
      warnings.push({
        message: `Orphan workspace: ${ws}`,
      });
    }
  }
}

/**
 * Format uptime duration
 */
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Display a single runner's health status
 */
async function displayRunnerHealth(
  runner: DiscoveredRunner,
  index: number,
  allFirecrackerProcesses: FirecrackerProcess[],
  allMitmproxyProcesses: MitmproxyProcess[],
): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const { config, pid, mode } = runner;
  const baseDir = config.base_dir;

  // Header
  console.log(`[${index}] ${baseDir} (PID ${pid}) [${mode}]`);

  // Status from status.json
  const statusFilePath = runnerPaths.statusFile(baseDir);
  const status = getRunnerStatus(statusFilePath, warnings);

  if (status) {
    let statusLine = `    Mode: ${status.mode}`;
    if (status.started_at) {
      const started = new Date(status.started_at);
      const uptime = formatUptime(Date.now() - started.getTime());
      statusLine += `, uptime: ${uptime}`;
    }
    console.log(statusLine);
  } else {
    console.log("    Mode: unknown (no status.json)");
  }

  // API connectivity
  const apiOk = await checkApiConnectivity(config, warnings);
  if (apiOk) {
    console.log(`    API: ✓ Connected to ${config.server.url}`);
  } else {
    console.log(`    API: ✗ Cannot connect to ${config.server.url}`);
  }

  // Proxy status
  const mitmProc = allMitmproxyProcesses.find((p) => p.baseDir === baseDir);
  if (mitmProc) {
    console.log(
      `    Proxy: ✓ mitmproxy (PID ${mitmProc.pid}) on :${config.proxy.port}`,
    );
  } else if (mode === "start") {
    console.log("    Proxy: ✗ not running");
    warnings.push({ message: "Proxy mitmproxy is not running" });
  } else {
    // benchmark mode - proxy is optional
    console.log("    Proxy: - (not running)");
  }

  // Active runs
  const { jobs, statusVmIds } = buildJobInfo(
    status,
    allFirecrackerProcesses,
    baseDir,
  );
  console.log(
    `    Runs (${jobs.length} active, max ${config.sandbox.max_concurrent}):`,
  );

  if (jobs.length === 0) {
    console.log("      No active runs");
  } else {
    for (const job of jobs) {
      const statusText = job.firecrackerPid
        ? `✓ Running (PID ${job.firecrackerPid})`
        : "⚠️ No process";
      console.log(`      ${job.vmId}  ${statusText}`);
    }
  }

  // Detect orphan resources for this runner
  const workspacesDir = runnerPaths.workspacesDir(baseDir);
  const workspaces = existsSync(workspacesDir)
    ? readdirSync(workspacesDir).filter(runnerPaths.isVmWorkspace)
    : [];

  detectRunnerOrphanResources(
    jobs,
    allFirecrackerProcesses,
    workspaces,
    statusVmIds,
    baseDir,
    warnings,
  );

  // Display warnings
  console.log(`    Warnings:`);
  if (warnings.length === 0) {
    console.log("      None");
  } else {
    for (const w of warnings) {
      console.log(`      - ${w.message}`);
    }
  }

  return warnings;
}

/**
 * Detect global orphan resources (not belonging to any discovered runner)
 */
async function detectGlobalOrphans(
  discoveredRunners: DiscoveredRunner[],
  allFirecrackerProcesses: FirecrackerProcess[],
  allMitmproxyProcesses: MitmproxyProcess[],
  globalWarnings: Warning[],
): Promise<void> {
  const runnerBaseDirs = new Set(
    discoveredRunners.map((r) => r.config.base_dir),
  );

  // Orphan mitmproxy processes
  for (const mitm of allMitmproxyProcesses) {
    if (mitm.isOrphan) {
      globalWarnings.push({
        message: `Orphan mitmproxy: PID ${mitm.pid} (PPID=1, parent process dead)`,
      });
    } else if (!runnerBaseDirs.has(mitm.baseDir)) {
      globalWarnings.push({
        message: `Orphan mitmproxy: PID ${mitm.pid} (baseDir ${mitm.baseDir}, runner not running)`,
      });
    }
  }

  // Orphan Firecracker processes
  for (const fc of allFirecrackerProcesses) {
    if (fc.isOrphan) {
      globalWarnings.push({
        message: `Orphan Firecracker: PID ${fc.pid} (vmId ${fc.vmId}, PPID=1, parent process dead)`,
      });
    } else if (!runnerBaseDirs.has(fc.baseDir)) {
      globalWarnings.push({
        message: `Orphan Firecracker: PID ${fc.pid} (vmId ${fc.vmId}, baseDir ${fc.baseDir}, runner not running)`,
      });
    }
  }

  // Orphan network namespaces
  const orphanNetns = await findOrphanNetworkNamespaces(globalWarnings);
  for (const ns of orphanNetns) {
    globalWarnings.push({
      message: `Orphan namespace: ${ns} (runner process not running)`,
    });
  }
}

export const doctorCommand = new Command("doctor")
  .description("Diagnose health of all runners on this host")
  .action(async (): Promise<void> => {
    try {
      const globalWarnings: Warning[] = [];
      let totalWarnings = 0;

      // Scan all processes once
      const allFirecrackerProcesses = findFirecrackerProcesses();
      const allMitmproxyProcesses = findMitmproxyProcesses();

      // Discover all runner processes
      const runnerProcesses = findRunnerProcesses();

      // Load config for each runner
      const discoveredRunners: DiscoveredRunner[] = [];
      for (const rp of runnerProcesses) {
        try {
          const config = loadConfig(rp.configPath);
          discoveredRunners.push({
            pid: rp.pid,
            config,
            mode: rp.mode,
          });
        } catch (err) {
          globalWarnings.push({
            message: `Failed to load config ${rp.configPath}: ${err instanceof Error ? err.message : "Unknown error"}`,
          });
        }
      }

      // Display runners
      console.log(`Runners (${discoveredRunners.length} found):`);
      console.log("");

      if (discoveredRunners.length === 0) {
        console.log("    No runner processes found");
        console.log("");
      } else {
        // Check each runner
        for (let i = 0; i < discoveredRunners.length; i++) {
          const warnings = await displayRunnerHealth(
            discoveredRunners[i]!,
            i + 1,
            allFirecrackerProcesses,
            allMitmproxyProcesses,
          );
          totalWarnings += warnings.length;
          console.log("");
        }
      }

      // Global orphan detection
      await detectGlobalOrphans(
        discoveredRunners,
        allFirecrackerProcesses,
        allMitmproxyProcesses,
        globalWarnings,
      );

      console.log("Global:");
      if (globalWarnings.length === 0) {
        console.log("    No orphan resources");
      } else {
        for (const w of globalWarnings) {
          console.log(`    ${w.message}`);
        }
      }

      totalWarnings += globalWarnings.length;
      process.exit(totalWarnings > 0 ? 1 : 0);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      process.exit(1);
    }
  });
