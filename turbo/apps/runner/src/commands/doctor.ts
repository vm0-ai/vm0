/**
 * Runner Doctor Command
 *
 * Comprehensive health check for the runner, including:
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
  findMitmproxyProcess,
} from "../lib/firecracker/process.js";
import { withFileLock } from "../lib/utils/file-lock.js";
import { isProcessRunning } from "../lib/utils/process.js";
import { isPortInUse } from "../lib/firecracker/network.js";
import { SNAPSHOT_NETWORK } from "../lib/firecracker/netns.js";
import { NS_PREFIX, RegistrySchema } from "../lib/firecracker/netns-pool.js";
import { type VmId, createVmId } from "../lib/firecracker/vm-id.js";
import { type RunnerStatus, RunnerStatusSchema } from "../lib/runner/types.js";

interface JobInfo {
  runId: string;
  vmId: VmId;
  firecrackerPid?: number;
}

interface FirecrackerProcess {
  pid: number;
  vmId: VmId;
}

interface Warning {
  message: string;
}

/**
 * Display runner status from status.json
 */
function displayRunnerStatus(
  statusFilePath: string,
  warnings: Warning[],
): RunnerStatus | null {
  if (!existsSync(statusFilePath)) {
    console.log("Mode: unknown (no status.json)");
    return null;
  }

  try {
    const status = RunnerStatusSchema.parse(
      JSON.parse(readFileSync(statusFilePath, "utf-8")),
    );
    console.log(`Mode: ${status.mode}`);
    if (status.started_at) {
      const started = new Date(status.started_at);
      const uptime = formatUptime(Date.now() - started.getTime());
      console.log(`Started: ${started.toLocaleString()} (uptime: ${uptime})`);
    }
    return status;
  } catch {
    console.log("Mode: unknown (status.json unreadable)");
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
): Promise<void> {
  console.log("API Connectivity:");
  try {
    await pollForJob(config.server, config.group);
    console.log(`  ✓ Connected to ${config.server.url}`);
    console.log("  ✓ Authentication: OK");
  } catch (error) {
    console.log(`  ✗ Cannot connect to ${config.server.url}`);
    console.log(
      `    Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    warnings.push({
      message: `Cannot connect to API: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
}

/**
 * Check network status (proxy)
 */
async function checkNetwork(
  config: RunnerConfig,
  warnings: Warning[],
): Promise<void> {
  console.log("Network:");

  const proxyPort = config.proxy.port;
  const mitmProc = findMitmproxyProcess();
  const portInUse = await isPortInUse(proxyPort);

  if (mitmProc) {
    console.log(`  ✓ Proxy mitmproxy (PID ${mitmProc.pid}) on :${proxyPort}`);
  } else if (portInUse) {
    console.log(
      `  ⚠️ Proxy port :${proxyPort} in use but mitmproxy process not found`,
    );
    warnings.push({
      message: `Port ${proxyPort} is in use but mitmproxy process not detected`,
    });
  } else {
    console.log(`  ✗ Proxy mitmproxy not running`);
    warnings.push({ message: "Proxy mitmproxy is not running" });
  }

  console.log(
    `  ℹ Namespaces: each VM runs in isolated namespace with IP ${SNAPSHOT_NETWORK.guestIp}`,
  );
}

/**
 * Build job info from status and processes
 */
function buildJobInfo(
  status: RunnerStatus | null,
  processes: FirecrackerProcess[],
): { jobs: JobInfo[]; statusVmIds: Set<VmId> } {
  const jobs: JobInfo[] = [];
  const statusVmIds = new Set<VmId>();

  if (status?.active_run_ids) {
    for (const runId of status.active_run_ids) {
      const vmId = createVmId(runId);
      statusVmIds.add(vmId);
      const proc = processes.find((p) => p.vmId === vmId);

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
 * Display active runs
 */
function displayRuns(jobs: JobInfo[], maxConcurrent: number): void {
  console.log(`Runs (${jobs.length} active, max ${maxConcurrent}):`);

  if (jobs.length === 0) {
    console.log("  No active runs");
    return;
  }

  console.log("  Run ID                                VM ID       Status");
  for (const job of jobs) {
    const statusText = job.firecrackerPid
      ? `✓ Running (PID ${job.firecrackerPid})`
      : "⚠️ No process";

    console.log(`  ${job.runId}  ${job.vmId}    ${statusText}`);
  }
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
 * Detect orphan resources and add warnings
 */
async function detectOrphanResources(
  jobs: JobInfo[],
  processes: FirecrackerProcess[],
  workspaces: string[],
  statusVmIds: Set<VmId>,
  warnings: Warning[],
): Promise<void> {
  // Runs without process
  for (const job of jobs) {
    if (!job.firecrackerPid) {
      warnings.push({
        message: `Run ${job.vmId} in status.json but no Firecracker process running`,
      });
    }
  }

  // Orphan processes
  const processVmIds = new Set(processes.map((p) => p.vmId));
  for (const proc of processes) {
    if (!statusVmIds.has(proc.vmId)) {
      warnings.push({
        message: `Orphan process: PID ${proc.pid} (vmId ${proc.vmId}) not in status.json`,
      });
    }
  }

  // Orphan network namespaces
  const orphanNetns = await findOrphanNetworkNamespaces(warnings);
  for (const ns of orphanNetns) {
    warnings.push({
      message: `Orphan network namespace: ${ns} (runner process not running)`,
    });
  }

  // Orphan workspaces
  for (const ws of workspaces) {
    const vmId = runnerPaths.extractVmId(ws);
    if (!processVmIds.has(vmId) && !statusVmIds.has(vmId)) {
      warnings.push({
        message: `Orphan workspace: ${ws} (no matching job or process)`,
      });
    }
  }
}

/**
 * Display warnings
 */
function displayWarnings(warnings: Warning[]): void {
  console.log("Warnings:");
  if (warnings.length === 0) {
    console.log("  None");
  } else {
    for (const w of warnings) {
      console.log(`  - ${w.message}`);
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

export const doctorCommand = new Command("doctor")
  .description("Diagnose runner health, check network, and detect issues")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .action(async (options: { config: string }): Promise<void> => {
    try {
      const config = loadConfig(options.config);
      const statusFilePath = runnerPaths.statusFile(config.base_dir);
      const workspacesDir = runnerPaths.workspacesDir(config.base_dir);
      const warnings: Warning[] = [];

      // Runner info
      console.log(`Runner: ${config.name}`);
      const status = displayRunnerStatus(statusFilePath, warnings);
      console.log("");

      // API Connectivity
      await checkApiConnectivity(config, warnings);
      console.log("");

      // Network status
      await checkNetwork(config, warnings);
      console.log("");

      // Scan resources
      const processes = findFirecrackerProcesses();
      const workspaces = existsSync(workspacesDir)
        ? readdirSync(workspacesDir).filter(runnerPaths.isVmWorkspace)
        : [];

      // Build and display job info
      const { jobs, statusVmIds } = buildJobInfo(status, processes);
      displayRuns(jobs, config.sandbox.max_concurrent);
      console.log("");

      // Detect warnings
      await detectOrphanResources(
        jobs,
        processes,
        workspaces,
        statusVmIds,
        warnings,
      );

      // Display warnings
      displayWarnings(warnings);

      process.exit(warnings.length > 0 ? 1 : 0);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      process.exit(1);
    }
  });
