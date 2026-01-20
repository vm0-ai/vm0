/**
 * Runner Doctor Command
 *
 * Comprehensive health check for the runner, including:
 * - API connectivity
 * - Network status (bridge, proxy)
 * - Active jobs with IP allocation
 * - Warning detection (orphan resources, IP conflicts, iptables issues)
 */

import { Command } from "commander";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { loadConfig } from "../lib/config.js";
import { pollForJob } from "../lib/api.js";
import {
  findFirecrackerProcesses,
  findMitmproxyProcess,
} from "../lib/firecracker/process.js";
import {
  listTapDevices,
  checkBridgeStatus,
  isPortInUse,
  listIptablesNatRules,
  findOrphanedIptablesRules,
  BRIDGE_NAME,
} from "../lib/firecracker/network.js";
import { getIPForVm, getAllocations } from "../lib/firecracker/ip-pool.js";

interface RunnerStatus {
  mode: string;
  active_jobs: number;
  active_job_ids: string[];
  started_at: string;
  updated_at: string;
}

interface JobInfo {
  runId: string;
  vmId: string;
  ip: string;
  hasProcess: boolean;
  pid?: number;
}

interface Warning {
  message: string;
}

export const doctorCommand = new Command("doctor")
  .description("Diagnose runner health, check network, and detect issues")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .action(async (options: { config: string }): Promise<void> => {
    try {
      const config = loadConfig(options.config);
      const configDir = dirname(options.config);
      const statusFilePath = join(configDir, "status.json");
      const workspacesDir = join(configDir, "workspaces");

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

      // Check bridge
      const bridgeStatus = await checkBridgeStatus();
      if (bridgeStatus.exists) {
        console.log(`  ✓ Bridge ${BRIDGE_NAME} (${bridgeStatus.ip})`);
      } else {
        console.log(`  ✗ Bridge ${BRIDGE_NAME} not found`);
        warnings.push({
          message: `Network bridge ${BRIDGE_NAME} does not exist`,
        });
      }

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

      console.log("");

      // Scan resources first to get active VM IPs
      const processes = findFirecrackerProcesses();
      const tapDevices = await listTapDevices();
      const workspaces = existsSync(workspacesDir)
        ? readdirSync(workspacesDir).filter((d) => d.startsWith("vm0-"))
        : [];

      // Build job info with IP addresses
      const jobs: JobInfo[] = [];
      const statusVmIds = new Set<string>();
      // IP pool manager prevents collisions at allocation time, so we just read from registry
      const allocations = getAllocations();

      if (status?.active_job_ids) {
        for (const runId of status.active_job_ids) {
          const vmId = runId.split("-")[0];
          if (!vmId) continue;
          statusVmIds.add(vmId);
          const proc = processes.find((p) => p.vmId === vmId);
          // Look up IP from the registry (allocated by IP pool manager)
          const ip = getIPForVm(vmId) ?? "not allocated";

          jobs.push({
            runId,
            vmId,
            ip,
            hasProcess: !!proc,
            pid: proc?.pid,
          });
        }
      }

      // Check for any stale allocations in registry (IPs allocated but no active job)
      const ipToVmIds = new Map<string, string[]>();
      for (const [ip, allocation] of allocations) {
        const existing = ipToVmIds.get(ip) ?? [];
        existing.push(allocation.vmId);
        ipToVmIds.set(ip, existing);
      }

      // Display jobs
      const maxConcurrent = config.sandbox.max_concurrent;
      console.log(`Jobs (${jobs.length} active, max ${maxConcurrent}):`);

      if (jobs.length === 0) {
        console.log("  No active jobs");
      } else {
        console.log("  ID              VM ID       IP              Status");
        for (const job of jobs) {
          const shortId = job.runId.substring(0, 12) + "...";
          const ipConflict = (ipToVmIds.get(job.ip)?.length ?? 0) > 1;
          let statusText: string;

          if (ipConflict) {
            statusText = "⚠️ IP conflict!";
          } else if (job.hasProcess) {
            statusText = `✓ Running (PID ${job.pid})`;
          } else {
            statusText = "⚠️ No process";
          }

          console.log(
            `  ${shortId}  ${job.vmId}    ${job.ip.padEnd(15)} ${statusText}`,
          );
        }
      }

      console.log("");

      // Detect warnings

      // Jobs without process
      for (const job of jobs) {
        if (!job.hasProcess) {
          warnings.push({
            message: `Job ${job.vmId} in status.json but no Firecracker process running`,
          });
        }
      }

      // IP conflicts
      for (const [ip, vmIds] of ipToVmIds) {
        if (vmIds.length > 1) {
          warnings.push({
            message: `IP conflict: ${ip} assigned to ${vmIds.join(", ")}`,
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

      // Orphan TAP devices
      for (const tap of tapDevices) {
        const vmId = tap.replace("tap", "");
        if (!processVmIds.has(vmId) && !statusVmIds.has(vmId)) {
          warnings.push({
            message: `Orphan TAP device: ${tap} (no matching job or process)`,
          });
        }
      }

      // Orphan workspaces
      for (const ws of workspaces) {
        const vmId = ws.replace("vm0-", "");
        if (!processVmIds.has(vmId) && !statusVmIds.has(vmId)) {
          warnings.push({
            message: `Orphan workspace: ${ws} (no matching job or process)`,
          });
        }
      }

      // Orphan iptables rules
      const activeVmIps = new Set(jobs.map((j) => j.ip));
      const iptablesRules = await listIptablesNatRules();
      const orphanedIptables = await findOrphanedIptablesRules(
        iptablesRules,
        activeVmIps,
        proxyPort,
      );

      for (const rule of orphanedIptables) {
        warnings.push({
          message: `Orphan iptables rule: redirect ${rule.sourceIp}:${rule.destPort} -> :${rule.redirectPort}`,
        });
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
  });

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
