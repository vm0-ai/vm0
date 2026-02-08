import { Command } from "commander";
import chalk from "chalk";
import {
  apiClient,
  TelemetryMetric,
  RunEvent,
  NetworkLogEntry,
} from "../../lib/api/api-client";
import { getApiUrl } from "../../lib/api/config";
import { parseTime } from "../../lib/utils/time-parser";
import { formatBytes } from "../../lib/utils/file-utils";
import { ClaudeEventParser } from "../../lib/events/claude-event-parser";
import { EventRenderer } from "../../lib/events/event-renderer";
import { CodexEventRenderer } from "../../lib/events/codex-event-renderer";

/**
 * Build platform URL for logs viewer
 * Transforms API URL to platform URL and appends logs path
 */
function buildPlatformLogsUrl(apiUrl: string, runId: string): string {
  const url = new URL(apiUrl);
  const hostname = url.hostname;

  // Handle localhost
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `http://${hostname}:3001/logs/${runId}`;
  }

  // Transform: www.vm0.ai → platform.vm0.ai
  //            vm0.ai → platform.vm0.ai
  const parts = hostname.split(".");
  if (parts[0] === "www") {
    parts[0] = "platform";
  } else {
    parts.unshift("platform");
  }

  const platformHost = parts.join(".");
  const port = url.port ? `:${url.port}` : "";
  return `https://${platformHost}${port}/logs/${runId}`;
}

/**
 * Log type for mutually exclusive options
 */
type LogType = "agent" | "system" | "metrics" | "network";

/**
 * Format a single metric line
 */
function formatMetric(metric: TelemetryMetric): string {
  const memPercent = ((metric.mem_used / metric.mem_total) * 100).toFixed(1);
  const diskPercent = ((metric.disk_used / metric.disk_total) * 100).toFixed(1);

  return `[${metric.ts}] CPU: ${metric.cpu.toFixed(1)}% | Mem: ${formatBytes(metric.mem_used)}/${formatBytes(metric.mem_total)} (${memPercent}%) | Disk: ${formatBytes(metric.disk_used)}/${formatBytes(metric.disk_total)} (${diskPercent}%)`;
}

/**
 * Format a single network log entry
 * Supports two modes:
 * - sni: SNI-only mode (no HTTPS decryption, only host/port/action)
 * - mitm: MITM mode (full HTTP details including method, status, latency, sizes)
 */
// eslint-disable-next-line complexity -- TODO: refactor complex function
function formatNetworkLog(entry: NetworkLogEntry): string {
  // SNI-only mode: show connection info
  if (entry.mode === "sni" || !entry.method) {
    const actionColor = entry.action === "ALLOW" ? chalk.green : chalk.red;
    const host = entry.host || "unknown";
    const port = entry.port || 443;
    return `[${entry.timestamp}] ${chalk.cyan("SNI")} ${actionColor(entry.action || "ALLOW")} ${host}:${port} ${chalk.dim(entry.rule_matched || "")}`;
  }

  // MITM mode: show full HTTP details
  // Color status code based on HTTP status
  let statusColor: typeof chalk.green;
  const status = entry.status || 0;
  if (status >= 200 && status < 300) {
    statusColor = chalk.green;
  } else if (status >= 300 && status < 400) {
    statusColor = chalk.yellow;
  } else if (status >= 400) {
    statusColor = chalk.red;
  } else {
    statusColor = chalk.gray;
  }

  // Format latency with color
  let latencyColor: typeof chalk.green;
  const latencyMs = entry.latency_ms || 0;
  if (latencyMs < 500) {
    latencyColor = chalk.green;
  } else if (latencyMs < 2000) {
    latencyColor = chalk.yellow;
  } else {
    latencyColor = chalk.red;
  }

  const method = entry.method || "???";
  const requestSize = entry.request_size || 0;
  const responseSize = entry.response_size || 0;
  const url = entry.url || entry.host || "unknown";

  return `[${entry.timestamp}] ${method.padEnd(6)} ${statusColor(status)} ${latencyColor(latencyMs + "ms")} ${formatBytes(requestSize)}/${formatBytes(responseSize)} ${chalk.dim(url)}`;
}

/**
 * Create an EventRenderer for log viewing (with timestamps)
 * Uses buffered mode to group tool_use/tool_result together for consistent
 * rendering with vm0 run output
 */
function createLogRenderer(verbose: boolean): EventRenderer {
  return new EventRenderer({
    showTimestamp: true,
    verbose,
  });
}

/**
 * Render an agent event with timestamp for historical log viewing
 */
function renderAgentEvent(
  event: RunEvent,
  provider: string,
  renderer: EventRenderer,
): void {
  const eventData = event.eventData as Record<string, unknown>;

  if (provider === "codex") {
    // Use Codex renderer for Codex provider
    CodexEventRenderer.render(eventData);
  } else {
    // Use Claude Code renderer (default)
    const parsed = ClaudeEventParser.parse(eventData);
    if (parsed) {
      // Set timestamp from event
      parsed.timestamp = new Date(event.createdAt);
      renderer.render(parsed);
    }
  }
}

/**
 * Validate mutually exclusive options and return the log type
 */
function getLogType(options: {
  agent?: boolean;
  system?: boolean;
  metrics?: boolean;
  network?: boolean;
}): LogType {
  const selected = [
    options.agent,
    options.system,
    options.metrics,
    options.network,
  ].filter(Boolean).length;

  if (selected > 1) {
    console.error(
      chalk.red(
        "Options --agent, --system, --metrics, and --network are mutually exclusive",
      ),
    );
    process.exit(1);
  }

  if (options.system) return "system";
  if (options.metrics) return "metrics";
  if (options.network) return "network";
  return "agent"; // Default
}

export const logsCommand = new Command()
  .name("logs")
  .description("View logs for an agent run")
  .argument("<runId>", "Run ID to fetch logs for")
  .option("-a, --agent", "Show agent events (default)")
  .option("-s, --system", "Show system log")
  .option("-m, --metrics", "Show metrics")
  .option("-n, --network", "Show network logs (proxy traffic)")
  .option(
    "--since <time>",
    "Show logs since timestamp (e.g., 5m, 2h, 1d, 2024-01-15T10:30:00Z, 1705312200)",
  )
  .option("--tail <n>", "Show last N entries (default: 5, max: 100)")
  .option("--head <n>", "Show first N entries (max: 100)")
  .action(
    async (
      runId: string,
      options: {
        agent?: boolean;
        system?: boolean;
        metrics?: boolean;
        network?: boolean;
        since?: string;
        tail?: string;
        head?: string;
      },
    ) => {
      try {
        const logType = getLogType(options);

        // Validate --tail and --head are mutually exclusive
        if (options.tail !== undefined && options.head !== undefined) {
          console.error(
            chalk.red("Options --tail and --head are mutually exclusive"),
          );
          process.exit(1);
        }

        // Parse since option
        let since: number | undefined;
        if (options.since) {
          since = parseTime(options.since);
        }

        // Determine order and limit based on flags
        const isHead = options.head !== undefined;
        const limit = Math.min(
          Math.max(1, parseInt(options.head || options.tail || "5", 10)),
          100,
        );
        const order: "asc" | "desc" = isHead ? "asc" : "desc";

        // Build platform URL for agent logs
        const apiUrl = await getApiUrl();
        const platformUrl = buildPlatformLogsUrl(apiUrl, runId);

        switch (logType) {
          case "agent":
            await showAgentEvents(runId, { since, limit, order }, platformUrl);
            break;
          case "system":
            await showSystemLog(runId, { since, limit, order });
            break;
          case "metrics":
            await showMetrics(runId, { since, limit, order });
            break;
          case "network":
            await showNetworkLogs(runId, { since, limit, order });
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
  options: {
    since?: number;
    limit: number;
    order: "asc" | "desc";
  },
  platformUrl: string,
): Promise<void> {
  const response = await apiClient.getAgentEvents(runId, options);

  if (response.events.length === 0) {
    console.log(chalk.yellow("No agent events found for this run"));
    return;
  }

  // Reverse for chronological display when using tail (desc order)
  const events =
    options.order === "desc" ? [...response.events].reverse() : response.events;

  // Create renderer for log viewing (with timestamps, always verbose)
  const renderer = createLogRenderer(true);

  for (const event of events) {
    renderAgentEvent(event, response.framework, renderer);
  }

  if (response.hasMore) {
    console.log();
    console.log(
      chalk.dim(
        `Showing ${response.events.length} events. Use --tail to see more.`,
      ),
    );
  }
  console.log(chalk.dim(`View on platform: ${platformUrl}`));
}

/**
 * Show system log
 */
async function showSystemLog(
  runId: string,
  options: { since?: number; limit: number; order: "asc" | "desc" },
): Promise<void> {
  const response = await apiClient.getSystemLog(runId, options);

  if (!response.systemLog) {
    console.log(chalk.yellow("No system log found for this run"));
    return;
  }

  console.log(response.systemLog);

  if (response.hasMore) {
    console.log();
    console.log(
      chalk.dim("More log entries available. Use --tail to see more."),
    );
  }
}

/**
 * Show metrics
 */
async function showMetrics(
  runId: string,
  options: { since?: number; limit: number; order: "asc" | "desc" },
): Promise<void> {
  const response = await apiClient.getMetrics(runId, options);

  if (response.metrics.length === 0) {
    console.log(chalk.yellow("No metrics found for this run"));
    return;
  }

  // Reverse for chronological display when using tail (desc order)
  const metrics =
    options.order === "desc"
      ? [...response.metrics].reverse()
      : response.metrics;

  for (const metric of metrics) {
    console.log(formatMetric(metric));
  }

  if (response.hasMore) {
    console.log();
    console.log(
      chalk.dim(
        `Showing ${response.metrics.length} metrics. Use --tail to see more.`,
      ),
    );
  }
}

/**
 * Show network logs
 */
async function showNetworkLogs(
  runId: string,
  options: { since?: number; limit: number; order: "asc" | "desc" },
): Promise<void> {
  const response = await apiClient.getNetworkLogs(runId, options);

  if (response.networkLogs.length === 0) {
    console.log(
      chalk.yellow(
        "No network logs found for this run. Network logs are only captured when experimental_firewall is enabled on an experimental_runner",
      ),
    );
    return;
  }

  // Reverse for chronological display when using tail (desc order)
  const networkLogs =
    options.order === "desc"
      ? [...response.networkLogs].reverse()
      : response.networkLogs;

  for (const entry of networkLogs) {
    console.log(formatNetworkLog(entry));
  }

  if (response.hasMore) {
    console.log();
    console.log(
      chalk.dim(
        `Showing ${response.networkLogs.length} network logs. Use --tail to see more.`,
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
      console.error(chalk.red("✗ Not authenticated"));
      console.error(chalk.dim("  Run: vm0 auth login"));
    } else if (error.message.includes("not found")) {
      console.error(chalk.red(`✗ Run not found: ${runId}`));
    } else if (error.message.includes("Invalid time format")) {
      console.error(chalk.red(`✗ ${error.message}`));
    } else {
      console.error(chalk.red("✗ Failed to fetch logs"));
      console.error(chalk.dim(`  ${error.message}`));
    }
  } else {
    console.error(chalk.red("✗ An unexpected error occurred"));
  }
}
