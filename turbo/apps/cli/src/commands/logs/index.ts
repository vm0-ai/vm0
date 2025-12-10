import { Command } from "commander";
import chalk from "chalk";
import { apiClient, TelemetryMetric, RunEvent } from "../../lib/api-client";
import { parseTime } from "../../lib/time-parser";
import { ClaudeEventParser } from "../../lib/event-parser";
import { EventRenderer } from "../../lib/event-renderer";

/**
 * Log type for mutually exclusive options
 */
type LogType = "agent" | "system" | "metrics";

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Format a single metric line
 */
function formatMetric(metric: TelemetryMetric): string {
  const memPercent = ((metric.mem_used / metric.mem_total) * 100).toFixed(1);
  const diskPercent = ((metric.disk_used / metric.disk_total) * 100).toFixed(1);

  return `[${metric.ts}] CPU: ${metric.cpu.toFixed(1)}% | Mem: ${formatBytes(metric.mem_used)}/${formatBytes(metric.mem_total)} (${memPercent}%) | Disk: ${formatBytes(metric.disk_used)}/${formatBytes(metric.disk_total)} (${diskPercent}%)`;
}

/**
 * Render an agent event
 */
function renderAgentEvent(event: RunEvent): void {
  const parsed = ClaudeEventParser.parse(
    event.eventData as Record<string, unknown>,
  );
  if (parsed) {
    // Set timestamp from event
    parsed.timestamp = new Date(event.createdAt);
    EventRenderer.render(parsed);
  }
}

/**
 * Validate mutually exclusive options and return the log type
 */
function getLogType(options: {
  agent?: boolean;
  system?: boolean;
  metrics?: boolean;
}): LogType {
  const selected = [options.agent, options.system, options.metrics].filter(
    Boolean,
  ).length;

  if (selected > 1) {
    console.error(
      chalk.red(
        "Options --agent, --system, and --metrics are mutually exclusive",
      ),
    );
    process.exit(1);
  }

  if (options.system) return "system";
  if (options.metrics) return "metrics";
  return "agent"; // Default
}

export const logsCommand = new Command()
  .name("logs")
  .description("View logs for an agent run")
  .argument("<runId>", "Run ID to fetch logs for")
  .option("-a, --agent", "Show agent events (default)")
  .option("-s, --system", "Show system log")
  .option("-m, --metrics", "Show metrics")
  .option(
    "--since <time>",
    "Show logs since timestamp (e.g., 5m, 2h, 1d, 2024-01-15T10:30:00Z, 1705312200)",
  )
  .option(
    "--limit <n>",
    "Maximum number of entries to show (default: 5, max: 100)",
    "5",
  )
  .action(
    async (
      runId: string,
      options: {
        agent?: boolean;
        system?: boolean;
        metrics?: boolean;
        since?: string;
        limit?: string;
      },
    ) => {
      try {
        const logType = getLogType(options);

        // Parse since option
        let since: number | undefined;
        if (options.since) {
          since = parseTime(options.since);
        }

        // Parse and validate limit
        const limit = Math.min(
          Math.max(1, parseInt(options.limit || "5", 10)),
          100,
        );

        switch (logType) {
          case "agent":
            await showAgentEvents(runId, { since, limit });
            break;
          case "system":
            await showSystemLog(runId, { since, limit });
            break;
          case "metrics":
            await showMetrics(runId, { since, limit });
            break;
        }
      } catch (error) {
        handleError(error, runId);
        process.exit(1);
      }
    },
  );

/**
 * Show agent events
 */
async function showAgentEvents(
  runId: string,
  options: { since?: number; limit: number },
): Promise<void> {
  const response = await apiClient.getAgentEvents(runId, options);

  if (response.events.length === 0) {
    console.log(chalk.yellow("No agent events found for this run."));
    return;
  }

  for (const event of response.events) {
    renderAgentEvent(event);
  }

  if (response.hasMore) {
    console.log();
    console.log(
      chalk.gray(
        `Showing ${response.events.length} events. Use --limit to see more.`,
      ),
    );
  }
}

/**
 * Show system log
 */
async function showSystemLog(
  runId: string,
  options: { since?: number; limit: number },
): Promise<void> {
  const response = await apiClient.getSystemLog(runId, options);

  if (!response.systemLog) {
    console.log(chalk.yellow("No system log found for this run."));
    return;
  }

  console.log(response.systemLog);

  if (response.hasMore) {
    console.log();
    console.log(
      chalk.gray("More log entries available. Use --limit to see more."),
    );
  }
}

/**
 * Show metrics
 */
async function showMetrics(
  runId: string,
  options: { since?: number; limit: number },
): Promise<void> {
  const response = await apiClient.getMetrics(runId, options);

  if (response.metrics.length === 0) {
    console.log(chalk.yellow("No metrics found for this run."));
    return;
  }

  for (const metric of response.metrics) {
    console.log(formatMetric(metric));
  }

  if (response.hasMore) {
    console.log();
    console.log(
      chalk.gray(
        `Showing ${response.metrics.length} metrics. Use --limit to see more.`,
      ),
    );
  }
}

/**
 * Handle errors with friendly messages
 */
function handleError(error: unknown, runId: string): void {
  if (error instanceof Error) {
    if (error.message.includes("Not authenticated")) {
      console.error(chalk.red("Not authenticated. Run: vm0 auth login"));
    } else if (error.message.includes("not found")) {
      console.error(chalk.red(`Run not found: ${runId}`));
    } else if (error.message.includes("Invalid time format")) {
      console.error(chalk.red(error.message));
    } else {
      console.error(chalk.red("Failed to fetch logs"));
      console.error(chalk.gray(`  ${error.message}`));
    }
  } else {
    console.error(chalk.red("An unexpected error occurred"));
  }
}
