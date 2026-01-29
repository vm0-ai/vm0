import { Command } from "commander";
import chalk from "chalk";
import { listRuns } from "../../lib/api";
import { formatRelativeTime } from "../../lib/utils/file-utils";

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
        return;
      }

      // Calculate column widths
      const idWidth = 36; // UUID length
      const agentWidth = Math.max(
        5,
        ...activeRuns.map((r) => r.agentName.length),
      );
      const statusWidth = 7; // "running" is longest

      // Print header
      const header = [
        "ID".padEnd(idWidth),
        "AGENT".padEnd(agentWidth),
        "STATUS".padEnd(statusWidth),
        "CREATED",
      ].join("  ");
      console.log(chalk.dim(header));

      // Print rows
      for (const run of activeRuns) {
        const statusColor =
          run.status === "running" ? chalk.green : chalk.yellow;
        const row = [
          run.id.padEnd(idWidth),
          run.agentName.padEnd(agentWidth),
          statusColor(run.status.padEnd(statusWidth)),
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
