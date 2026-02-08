import { Command } from "commander";
import chalk from "chalk";
import { listRuns } from "../../lib/api";
import { formatRelativeTime } from "../../lib/utils/file-utils";
import type { RunStatus } from "@vm0/core";

/** Standard UUID string length (with hyphens) */
const UUID_LENGTH = 36;

/**
 * Format run status with color and optional padding
 */
function formatRunStatus(status: RunStatus, width?: number): string {
  const paddedStatus = width ? status.padEnd(width) : status;
  switch (status) {
    case "running":
      return chalk.green(paddedStatus);
    case "pending":
      return chalk.yellow(paddedStatus);
    case "completed":
      return chalk.dim(paddedStatus);
    case "failed":
    case "timeout":
      return chalk.red(paddedStatus);
    default:
      return paddedStatus;
  }
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List active runs (pending and running)")
  .action(async () => {
    try {
      // Fetch pending and running runs (internal API filters by default)
      const response = await listRuns({ limit: 100 });

      // The internal API already filters to pending/running by default
      const activeRuns = response.runs;

      if (activeRuns.length === 0) {
        console.log(chalk.dim("No active runs"));
        console.log(chalk.dim('  Run: vm0 run <agent> "<prompt>"'));
        return;
      }

      // Calculate column widths
      const agentWidth = Math.max(
        5,
        ...activeRuns.map((r) => r.agentName.length),
      );
      const statusWidth = 7; // "running" is longest active status

      // Print header
      const header = [
        "ID".padEnd(UUID_LENGTH),
        "AGENT".padEnd(agentWidth),
        "STATUS".padEnd(statusWidth),
        "CREATED",
      ].join("  ");
      console.log(chalk.dim(header));

      // Print rows
      for (const run of activeRuns) {
        const row = [
          run.id.padEnd(UUID_LENGTH),
          run.agentName.padEnd(agentWidth),
          formatRunStatus(run.status, statusWidth),
          formatRelativeTime(run.createdAt),
        ].join("  ");
        console.log(row);
      }
    } catch (error) {
      console.error(chalk.red("✗ Failed to list runs"));
      if (error instanceof Error) {
        if (error.message.includes("Not authenticated")) {
          console.error(chalk.dim("  Run: vm0 auth login"));
        } else {
          console.error(chalk.dim(`  ${error.message}`));
        }
      }
      process.exit(1);
    }
  });
