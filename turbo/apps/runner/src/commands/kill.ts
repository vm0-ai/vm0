/**
 * Runner Kill Command
 *
 * Force terminate a specific job and clean up all related resources:
 * - Kill Firecracker process
 * - Delete TAP device
 * - Remove workspace directory
 * - Update status.json
 */

import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import * as readline from "readline";
import { loadConfig } from "../lib/config.js";
import { findProcessByVmId, killProcess } from "../lib/firecracker/process.js";
import { deleteTapDevice } from "../lib/firecracker/network.js";

interface RunnerStatus {
  mode: string;
  active_runs: number;
  active_run_ids: string[];
  started_at: string;
  updated_at: string;
}

interface CleanupResult {
  step: string;
  success: boolean;
  message: string;
}

export const killCommand = new Command("kill")
  .description("Force terminate a run and clean up all resources")
  .argument("<run-id>", "Run ID (full UUID or short 8-char vmId)")
  .option("--config <path>", "Config file path", "./runner.yaml")
  .option("--force", "Skip confirmation prompt")
  .action(
    async (
      runIdArg: string,
      options: { config: string; force?: boolean },
    ): Promise<void> => {
      try {
        loadConfig(options.config); // Validate config exists
        const configDir = dirname(options.config);
        const statusFilePath = join(configDir, "status.json");
        const workspacesDir = join(configDir, "workspaces");

        // Resolve run ID
        const { vmId, runId } = resolveRunId(runIdArg, statusFilePath);

        console.log(`Killing run ${vmId}...`);

        // Find resources
        const proc = findProcessByVmId(vmId);
        const tapDevice = `tap${vmId}`;
        const workspaceDir = join(workspacesDir, `vm0-${vmId}`);

        // Show what will be cleaned up
        console.log("");
        console.log("Resources to clean up:");
        if (proc) {
          console.log(`  - Firecracker process (PID ${proc.pid})`);
        } else {
          console.log("  - Firecracker process: not found");
        }
        console.log(`  - TAP device: ${tapDevice}`);
        console.log(`  - Workspace: ${workspaceDir}`);
        if (runId) {
          console.log(`  - status.json entry: ${runId.substring(0, 12)}...`);
        }
        console.log("");

        // Confirm
        if (!options.force) {
          const confirmed = await confirm("Proceed with cleanup?");
          if (!confirmed) {
            console.log("Aborted.");
            process.exit(0);
          }
        }

        // Perform cleanup
        const results: CleanupResult[] = [];

        // 1. Kill process
        if (proc) {
          const killed = await killProcess(proc.pid);
          results.push({
            step: "Firecracker process",
            success: killed,
            message: killed
              ? `PID ${proc.pid} terminated`
              : `Failed to kill PID ${proc.pid}`,
          });
        } else {
          results.push({
            step: "Firecracker process",
            success: true,
            message: "Not running",
          });
        }

        // 2. Delete TAP device
        try {
          await deleteTapDevice(tapDevice);
          results.push({
            step: "TAP device",
            success: true,
            message: `${tapDevice} deleted`,
          });
        } catch (error) {
          results.push({
            step: "TAP device",
            success: false,
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }

        // 3. Remove workspace
        if (existsSync(workspaceDir)) {
          try {
            rmSync(workspaceDir, { recursive: true, force: true });
            results.push({
              step: "Workspace",
              success: true,
              message: `${workspaceDir} removed`,
            });
          } catch (error) {
            results.push({
              step: "Workspace",
              success: false,
              message: error instanceof Error ? error.message : "Unknown error",
            });
          }
        } else {
          results.push({
            step: "Workspace",
            success: true,
            message: "Not found (already cleaned)",
          });
        }

        // 4. Update status.json
        if (runId && existsSync(statusFilePath)) {
          try {
            const status: RunnerStatus = JSON.parse(
              readFileSync(statusFilePath, "utf-8"),
            ) as RunnerStatus;
            const oldCount = status.active_runs;
            status.active_run_ids = status.active_run_ids.filter(
              (id: string) => id !== runId,
            );
            status.active_runs = status.active_run_ids.length;
            status.updated_at = new Date().toISOString();
            writeFileSync(statusFilePath, JSON.stringify(status, null, 2));
            results.push({
              step: "status.json",
              success: true,
              message: `Updated (active_runs: ${oldCount} -> ${status.active_runs})`,
            });
          } catch (error) {
            results.push({
              step: "status.json",
              success: false,
              message: error instanceof Error ? error.message : "Unknown error",
            });
          }
        } else {
          results.push({
            step: "status.json",
            success: true,
            message: "No update needed",
          });
        }

        // Display results
        console.log("");
        let allSuccess = true;
        for (const r of results) {
          const icon = r.success ? "✓" : "✗";
          console.log(`  ${icon} ${r.step}: ${r.message}`);
          if (!r.success) allSuccess = false;
        }

        console.log("");
        if (allSuccess) {
          console.log(`Run ${vmId} killed successfully.`);
          process.exit(0);
        } else {
          console.log(`Run ${vmId} cleanup completed with errors.`);
          process.exit(1);
        }
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        process.exit(1);
      }
    },
  );

function resolveRunId(
  input: string,
  statusFilePath: string,
): { vmId: string; runId: string | null } {
  if (input.includes("-")) {
    const vmId = input.split("-")[0];
    return { vmId: vmId ?? input, runId: input };
  }

  if (existsSync(statusFilePath)) {
    try {
      const status: RunnerStatus = JSON.parse(
        readFileSync(statusFilePath, "utf-8"),
      ) as RunnerStatus;
      const match = status.active_run_ids.find((id: string) =>
        id.startsWith(input),
      );
      if (match) {
        return { vmId: input, runId: match };
      }
    } catch {
      // Ignore parsing errors
    }
  }

  return { vmId: input, runId: null };
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}
