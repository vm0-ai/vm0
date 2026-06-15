import { Command } from "commander";
import chalk from "chalk";
import { listZeroLogs } from "../../../lib/api";
import { parseTime } from "../../../lib/utils/time-parser";
import { withErrorHandler } from "../../../lib/command";

function formatStatus(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "failed":
    case "timeout":
      return chalk.red(status);
    case "running":
    case "pending":
    case "queued":
      return chalk.yellow(status);
    case "cancelled":
      return chalk.dim(status);
    default:
      return status;
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List agent run logs")
  .option("--agent <id>", "Filter by Zero agent ID")
  .option(
    "--status <status>",
    "Filter by status (queued|pending|running|completed|failed|timeout|cancelled)",
  )
  .option(
    "--since <time>",
    "Filter runs created since (e.g., 5m, 2h, 1d, 2024-01-15T10:30:00Z)",
  )
  .option("--limit <n>", "Maximum number of results (default: 20)")
  .addHelpText(
    "after",
    `
Examples:
  zero logs list
  zero logs list --agent 123e4567-e89b-12d3-a456-426614174000
  zero logs list --status completed --limit 10
  zero logs list --since 1h
  zero logs list --since 1d --status completed`,
  )
  .action(
    withErrorHandler(
      async (options: {
        agent?: string;
        status?: string;
        since?: string;
        limit?: string;
      }) => {
        const limit = options.limit ? parseInt(options.limit, 10) : undefined;
        const since = options.since ? parseTime(options.since) : undefined;

        const result = await listZeroLogs({
          agentId: options.agent,
          status: options.status,
          since,
          limit,
        });

        if (result.data.length === 0) {
          console.log(chalk.dim("No logs found"));
          return;
        }

        const nameCol = Math.max(
          5,
          ...result.data.map((r) => {
            return (r.displayName || r.agentId || "-").length;
          }),
        );
        const statusCol = Math.max(
          6,
          ...result.data.map((r) => {
            return r.status.length;
          }),
        );

        const header = [
          "RUN ID".padEnd(38),
          "AGENT".padEnd(nameCol),
          "STATUS".padEnd(statusCol),
          "CREATED",
        ].join("  ");
        console.log(chalk.dim(header));

        for (const entry of result.data) {
          const runId = entry.id;
          const name = entry.displayName || entry.agentId || "-";
          const row = [
            runId.padEnd(38),
            name.padEnd(nameCol),
            formatStatus(entry.status).padEnd(statusCol),
            formatTime(entry.createdAt),
          ].join("  ");
          console.log(row);
        }

        if (result.pagination.hasMore) {
          console.log();
          console.log(
            chalk.dim(
              `  Showing ${result.data.length} of more results. Use --limit to adjust.`,
            ),
          );
        }
      },
    ),
  );
