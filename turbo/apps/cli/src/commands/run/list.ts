import { Command } from "commander";
import chalk from "chalk";
import { listRuns } from "../../lib/api";
import { formatRelativeTime } from "../../lib/utils/file-utils";
import { parseTime } from "../../lib/utils/time-parser";
import { ALL_RUN_STATUSES, type RunStatus, type RunListItem } from "@vm0/core";

/** Standard UUID string length (with hyphens) */
const UUID_LENGTH = 36;

/** All valid status values as a string for help text */
const VALID_STATUSES = ALL_RUN_STATUSES.join(",");

/**
 * Command options type
 */
interface ListOptions {
  status?: string;
  all?: boolean;
  agent?: string;
  since?: string;
  until?: string;
  limit?: string;
}

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

/**
 * Validate and parse status filter from options
 */
function parseStatusFilter(options: ListOptions): string | undefined {
  if (options.all) {
    return VALID_STATUSES;
  }

  if (options.status) {
    const values = options.status.split(",").map((s) => s.trim());
    for (const v of values) {
      if (!ALL_RUN_STATUSES.includes(v as RunStatus)) {
        console.error(
          chalk.red(
            `Error: Invalid status "${v}". Valid values: ${VALID_STATUSES}`,
          ),
        );
        process.exit(1);
      }
    }
    return values.join(",");
  }

  if (options.since) {
    // Implicit all when --since is used
    return VALID_STATUSES;
  }

  // undefined = backend default (pending,running)
  return undefined;
}

/**
 * Parse time option to ISO string
 */
function parseTimeOption(value: string, optionName: string): string {
  try {
    return new Date(parseTime(value)).toISOString();
  } catch {
    console.error(
      chalk.red(
        `Error: Invalid ${optionName} format. Use ISO (2026-01-01) or relative (1h, 7d, 30d)`,
      ),
    );
    process.exit(1);
  }
}

/**
 * Parse and validate limit option
 */
function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const limit = parseInt(value, 10);
  if (isNaN(limit) || limit < 1 || limit > 100) {
    console.error(chalk.red("Error: --limit must be between 1 and 100"));
    process.exit(1);
  }
  return limit;
}

/**
 * Display runs in table format
 */
function displayRuns(runs: RunListItem[]): void {
  // Calculate column widths
  const agentWidth = Math.max(5, ...runs.map((r) => r.agentName.length));
  const statusWidth = Math.max(6, ...runs.map((r) => r.status.length));

  // Print header
  const header = [
    "ID".padEnd(UUID_LENGTH),
    "AGENT".padEnd(agentWidth),
    "STATUS".padEnd(statusWidth),
    "CREATED",
  ].join("  ");
  console.log(chalk.dim(header));

  // Print rows
  for (const run of runs) {
    const row = [
      run.id.padEnd(UUID_LENGTH),
      run.agentName.padEnd(agentWidth),
      formatRunStatus(run.status, statusWidth),
      formatRelativeTime(run.createdAt),
    ].join("  ");
    console.log(row);
  }
}

/**
 * Display empty state message
 */
function displayEmptyState(hasFilters: boolean): void {
  if (hasFilters) {
    console.log(chalk.dim("No runs found matching filters"));
  } else {
    console.log(chalk.dim("No active runs"));
    console.log(chalk.dim('  Run: vm0 run <agent> "<prompt>"'));
  }
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List runs")
  .option(
    "--status <status,...>",
    `Filter by status: ${VALID_STATUSES} (default: pending,running)`,
  )
  .option("--all", "Show all statuses (mutually exclusive with --status)")
  .option("--agent <name>", "Filter by agent name")
  .option("--since <date>", "Start time (ISO format or relative: 1h, 7d, 30d)")
  .option("--until <date>", "End time (defaults to now)")
  .option("--limit <n>", "Maximum number of results (default: 50, max: 100)")
  .action(async (options: ListOptions) => {
    try {
      // Validate mutual exclusion
      if (options.all && options.status) {
        console.error(
          chalk.red("Error: --all and --status are mutually exclusive"),
        );
        process.exit(1);
      }

      // Parse options
      const statusFilter = parseStatusFilter(options);
      const since = options.since
        ? parseTimeOption(options.since, "--since")
        : undefined;
      const until = options.until
        ? parseTimeOption(options.until, "--until")
        : undefined;
      const limit = parseLimit(options.limit);

      // Validate since < until
      if (since && until && new Date(since) >= new Date(until)) {
        console.error(chalk.red("Error: --since must be before --until"));
        process.exit(1);
      }

      // Fetch runs with filters
      const response = await listRuns({
        status: statusFilter,
        agent: options.agent,
        since,
        until,
        limit,
      });

      const runs = response.runs;

      if (runs.length === 0) {
        const hasFilters = !!(
          options.status ||
          options.all ||
          options.agent ||
          options.since
        );
        displayEmptyState(hasFilters);
        return;
      }

      displayRuns(runs);
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
