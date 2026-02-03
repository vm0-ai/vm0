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
import { loadConfig } from "../lib/config.js";
import { runnerPaths } from "../lib/paths.js";
import { pollForJob } from "../lib/api.js";
import {
  findFirecrackerProcesses,
  findMitmproxyProcess,
} from "../lib/firecracker/process.js";
import { isPortInUse } from "../lib/firecracker/network.js";
import { SNAPSHOT_NETWORK } from "../lib/firecracker/netns.js";
import { type VmId, createVmId } from "../lib/firecracker/vm-id.js";

interface RunnerStatus {
  mode: string;
  active_runs: number;
  active_run_ids: string[];
  started_at: string;
  updated_at: string;
}

interface JobInfo {
  runId: string;
  vmId: VmId;
  hasProcess: boolean;
  pid?: number;
}

interface Warning {
  message: string;
}

export const doctorCommand = new Command("doctor")
  .description("Diagnose runner health, check network, and detect issues")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .action(
    // eslint-disable-next-line complexity -- TODO: refactor complex function
    async (options: { config: string }): Promise<void> => {
      try {
        const config = loadConfig(options.config);
        const statusFilePath = runnerPaths.statusFile(config.base_dir);
        const workspacesDir = runnerPaths.workspacesDir(config.base_dir);

        // Runner info
        console.log(`Runner: ${config.name}`);

        // Read status.json
        let status: RunnerStatus | null = null;
        if (existsSync(statusFilePath)) {
          try {
            status = JSON.parse(
              readFileSync(statusFilePath, "utf-8"),
            ) as RunnerStatus;
            console.log(`Mode: ${status.mode}`);
            if (status.started_at) {
              const started = new Date(status.started_at);
              const uptime = formatUptime(Date.now() - started.getTime());
              console.log(
                `Started: ${started.toLocaleString()} (uptime: ${uptime})`,
              );
            }
          } catch {
            console.log("Mode: unknown (status.json unreadable)");
          }
        } else {
          console.log("Mode: unknown (no status.json)");
        }

        console.log("");

        // API Connectivity
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
        }

        console.log("");

        // Network status
        console.log("Network:");
        const warnings: Warning[] = [];

        // Check mitmproxy
        const proxyPort = config.proxy.port;
        const mitmProc = findMitmproxyProcess();
        const portInUse = await isPortInUse(proxyPort);

        if (mitmProc) {
          console.log(
            `  ✓ Proxy mitmproxy (PID ${mitmProc.pid}) on :${proxyPort}`,
          );
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

        // Network namespace info
        console.log(
          `  ℹ Namespaces: each VM runs in isolated namespace with IP ${SNAPSHOT_NETWORK.guestIp}`,
        );

        console.log("");

        // Scan resources
        const processes = findFirecrackerProcesses();
        const workspaces = existsSync(workspacesDir)
          ? readdirSync(workspacesDir).filter(runnerPaths.isVmWorkspace)
          : [];

        // Build job info
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
              hasProcess: !!proc,
              pid: proc?.pid,
            });
          }
        }

        // Display runs
        const maxConcurrent = config.sandbox.max_concurrent;
        console.log(`Runs (${jobs.length} active, max ${maxConcurrent}):`);

        if (jobs.length === 0) {
          console.log("  No active runs");
        } else {
          console.log(
            "  Run ID                                VM ID       Status",
          );
          for (const job of jobs) {
            const statusText = job.hasProcess
              ? `✓ Running (PID ${job.pid})`
              : "⚠️ No process";

            console.log(`  ${job.runId}  ${job.vmId}    ${statusText}`);
          }
        }

        console.log("");

        // Detect warnings

        // Runs without process
        for (const job of jobs) {
          if (!job.hasProcess) {
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

        // Note: Network namespaces are managed by NetnsPool, which handles orphan cleanup
        // during init(). No need to check for orphan namespaces here.

        // Orphan workspaces
        for (const ws of workspaces) {
          const vmId = runnerPaths.extractVmId(ws);
          if (!processVmIds.has(vmId) && !statusVmIds.has(vmId)) {
            warnings.push({
              message: `Orphan workspace: ${ws} (no matching job or process)`,
            });
          }
        }

        // Display warnings
        console.log("Warnings:");
        if (warnings.length === 0) {
          console.log("  None");
        } else {
          for (const w of warnings) {
            console.log(`  - ${w.message}`);
          }
        }

        process.exit(warnings.length > 0 ? 1 : 0);
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        process.exit(1);
      }
    },
  );

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
