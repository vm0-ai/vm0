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
import { paginate } from "../../lib/utils/paginate";

/**
 * Maximum entries per API request
 */
const PAGE_LIMIT = 100;

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
 * Format an SNI-mode network log entry (no HTTPS decryption, only host/port/action)
 */
function formatSniLog(entry: NetworkLogEntry): string {
  const actionColor = entry.action === "ALLOW" ? chalk.green : chalk.red;
  const host = entry.host || "unknown";
  const port = entry.port || 443;
  return `[${entry.timestamp}] ${chalk.cyan("SNI")} ${actionColor(entry.action || "ALLOW")} ${host}:${port} ${chalk.dim(entry.rule_matched || "")}`;
}

/**
 * Format a MITM-mode network log entry (full HTTP details including method, status, latency, sizes)
 */
function formatMitmLog(entry: NetworkLogEntry): string {
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
 * Format a single network log entry
 */
function formatNetworkLog(entry: NetworkLogEntry): string {
  if (entry.mode === "sni" || !entry.method) {
    return formatSniLog(entry);
  }
  return formatMitmLog(entry);
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
  .option("--tail <n>", "Show last N entries (default: 5)")
  .option("--head <n>", "Show first N entries")
  .option("--all", "Fetch all log entries")
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
        all?: boolean;
      },
    ) => {
      try {
        const logType = getLogType(options);

        // Validate --tail, --head, and --all are mutually exclusive
        const countModes = [
          options.tail !== undefined,
          options.head !== undefined,
          options.all === true,
        ].filter(Boolean).length;
        if (countModes > 1) {
          console.error(
            chalk.red(
              "Options --tail, --head, and --all are mutually exclusive",
            ),
          );
          process.exit(1);
        }

        // Parse since option
        let since: number | undefined;
        if (options.since) {
          since = parseTime(options.since);
        }

        // Determine pagination mode and order based on flags
        const isAll = options.all === true;
        const isHead = options.head !== undefined;
        const isTail = options.tail !== undefined;

        // targetCount: number for --head/--tail, "all" for --all, default 5 for no flag
        let targetCount: number | "all";
        if (isAll) {
          targetCount = "all";
        } else if (isHead) {
          targetCount = Math.max(1, parseInt(options.head!, 10));
        } else if (isTail) {
          targetCount = Math.max(1, parseInt(options.tail!, 10));
        } else {
          // Default: show last 5 entries
          targetCount = 5;
        }

        // Order: asc for --head, desc for --tail/--all/default
        const order: "asc" | "desc" = isHead ? "asc" : "desc";

        // Build platform URL for agent logs
        const apiUrl = await getApiUrl();
        const platformUrl = buildPlatformLogsUrl(apiUrl, runId);

        switch (logType) {
          case "agent":
            await showAgentEvents(
              runId,
              { since, targetCount, order },
              platformUrl,
            );
            break;
          case "system":
            await showSystemLog(runId, { since, targetCount, order });
            break;
          case "metrics":
            await showMetrics(runId, { since, targetCount, order });
            break;
          case "network":
            await showNetworkLogs(runId, { since, targetCount, order });
            break;
        }
      } catch (error) {
        handleError(error, runId);
        process.exit(1);
      }
    },
  );

/**
 * Show agent events with pagination support
 */
async function showAgentEvents(
  runId: string,
  options: {
    since?: number;
    targetCount: number | "all";
    order: "asc" | "desc";
  },
  platformUrl: string,
): Promise<void> {
  // Fetch first page to get framework info
  const firstResponse = await apiClient.getAgentEvents(runId, {
    since: options.since,
    limit: PAGE_LIMIT,
    order: options.order,
  });

  if (firstResponse.events.length === 0) {
    console.log(chalk.yellow("No agent events found for this run"));
    return;
  }

  const framework = firstResponse.framework;

  // Use pagination to collect all needed events
  let allEvents: RunEvent[];

  if (
    !firstResponse.hasMore ||
    (options.targetCount !== "all" &&
      firstResponse.events.length >= options.targetCount)
  ) {
    // Single page is enough
    allEvents =
      options.targetCount === "all"
        ? firstResponse.events
        : firstResponse.events.slice(0, options.targetCount);
  } else {
    // Need to paginate
    const lastEvent = firstResponse.events[firstResponse.events.length - 1];
    const firstPageTimestamp = lastEvent
      ? new Date(lastEvent.createdAt).getTime()
      : undefined;

    const remainingEvents = await paginate<RunEvent>({
      fetchPage: async (since) => {
        const response = await apiClient.getAgentEvents(runId, {
          since,
          limit: PAGE_LIMIT,
          order: options.order,
        });
        return { items: response.events, hasMore: response.hasMore };
      },
      getTimestamp: (event) => new Date(event.createdAt).getTime(),
      targetCount:
        options.targetCount === "all"
          ? "all"
          : options.targetCount - firstResponse.events.length,
      initialSince: firstPageTimestamp,
    });

    allEvents = [...firstResponse.events, ...remainingEvents];

    // Trim to target count if needed
    if (
      options.targetCount !== "all" &&
      allEvents.length > options.targetCount
    ) {
      allEvents = allEvents.slice(0, options.targetCount);
    }
  }

  // Reverse for chronological display when using desc order (--tail)
  const events =
    options.order === "desc" ? [...allEvents].reverse() : allEvents;

  // Create renderer for log viewing (with timestamps, always verbose)
  const renderer = createLogRenderer(true);

  for (const event of events) {
    renderAgentEvent(event, framework, renderer);
  }

  console.log(chalk.dim(`View on platform: ${platformUrl}`));
}

/**
 * Show system log with pagination support
 * Note: System log pagination is limited because the API returns aggregated strings
 * without individual timestamps. The --tail/--head/--all options work on batch count,
 * not line count.
 */
async function showSystemLog(
  runId: string,
  options: {
    since?: number;
    targetCount: number | "all";
    order: "asc" | "desc";
  },
): Promise<void> {
  // For system log, we fetch with a high limit to get more batches
  // The API aggregates batches into a single string
  const limit =
    options.targetCount === "all"
      ? PAGE_LIMIT
      : Math.min(options.targetCount, PAGE_LIMIT);

  const response = await apiClient.getSystemLog(runId, {
    since: options.since,
    limit,
    order: options.order,
  });

  if (!response.systemLog) {
    console.log(chalk.yellow("No system log found for this run"));
    return;
  }

  console.log(response.systemLog);
}

/**
 * Show metrics with pagination support
 */
async function showMetrics(
  runId: string,
  options: {
    since?: number;
    targetCount: number | "all";
    order: "asc" | "desc";
  },
): Promise<void> {
  // Fetch first page
  const firstResponse = await apiClient.getMetrics(runId, {
    since: options.since,
    limit: PAGE_LIMIT,
    order: options.order,
  });

  if (firstResponse.metrics.length === 0) {
    console.log(chalk.yellow("No metrics found for this run"));
    return;
  }

  // Use pagination to collect all needed metrics
  let allMetrics: TelemetryMetric[];

  if (
    !firstResponse.hasMore ||
    (options.targetCount !== "all" &&
      firstResponse.metrics.length >= options.targetCount)
  ) {
    // Single page is enough
    allMetrics =
      options.targetCount === "all"
        ? firstResponse.metrics
        : firstResponse.metrics.slice(0, options.targetCount);
  } else {
    // Need to paginate
    const lastMetric = firstResponse.metrics[firstResponse.metrics.length - 1];
    const firstPageTimestamp = lastMetric
      ? new Date(lastMetric.ts).getTime()
      : undefined;

    const remainingMetrics = await paginate<TelemetryMetric>({
      fetchPage: async (since) => {
        const response = await apiClient.getMetrics(runId, {
          since,
          limit: PAGE_LIMIT,
          order: options.order,
        });
        return { items: response.metrics, hasMore: response.hasMore };
      },
      getTimestamp: (metric) => new Date(metric.ts).getTime(),
      targetCount:
        options.targetCount === "all"
          ? "all"
          : options.targetCount - firstResponse.metrics.length,
      initialSince: firstPageTimestamp,
    });

    allMetrics = [...firstResponse.metrics, ...remainingMetrics];

    // Trim to target count if needed
    if (
      options.targetCount !== "all" &&
      allMetrics.length > options.targetCount
    ) {
      allMetrics = allMetrics.slice(0, options.targetCount);
    }
  }

  // Reverse for chronological display when using desc order (--tail)
  const metrics =
    options.order === "desc" ? [...allMetrics].reverse() : allMetrics;

  for (const metric of metrics) {
    console.log(formatMetric(metric));
  }
}

/**
 * Show network logs with pagination support
 */
async function showNetworkLogs(
  runId: string,
  options: {
    since?: number;
    targetCount: number | "all";
    order: "asc" | "desc";
  },
): Promise<void> {
  // Fetch first page
  const firstResponse = await apiClient.getNetworkLogs(runId, {
    since: options.since,
    limit: PAGE_LIMIT,
    order: options.order,
  });

  if (firstResponse.networkLogs.length === 0) {
    console.log(
      chalk.yellow(
        "No network logs found for this run. Network logs are only captured when experimental_firewall is enabled on an experimental_runner",
      ),
    );
    return;
  }

  // Use pagination to collect all needed network logs
  let allNetworkLogs: NetworkLogEntry[];

  if (
    !firstResponse.hasMore ||
    (options.targetCount !== "all" &&
      firstResponse.networkLogs.length >= options.targetCount)
  ) {
    // Single page is enough
    allNetworkLogs =
      options.targetCount === "all"
        ? firstResponse.networkLogs
        : firstResponse.networkLogs.slice(0, options.targetCount);
  } else {
    // Need to paginate
    const lastLog =
      firstResponse.networkLogs[firstResponse.networkLogs.length - 1];
    const firstPageTimestamp = lastLog
      ? new Date(lastLog.timestamp).getTime()
      : undefined;

    const remainingLogs = await paginate<NetworkLogEntry>({
      fetchPage: async (since) => {
        const response = await apiClient.getNetworkLogs(runId, {
          since,
          limit: PAGE_LIMIT,
          order: options.order,
        });
        return { items: response.networkLogs, hasMore: response.hasMore };
      },
      getTimestamp: (entry) => new Date(entry.timestamp).getTime(),
      targetCount:
        options.targetCount === "all"
          ? "all"
          : options.targetCount - firstResponse.networkLogs.length,
      initialSince: firstPageTimestamp,
    });

    allNetworkLogs = [...firstResponse.networkLogs, ...remainingLogs];

    // Trim to target count if needed
    if (
      options.targetCount !== "all" &&
      allNetworkLogs.length > options.targetCount
    ) {
      allNetworkLogs = allNetworkLogs.slice(0, options.targetCount);
    }
  }

  // Reverse for chronological display when using desc order (--tail)
  const networkLogs =
    options.order === "desc" ? [...allNetworkLogs].reverse() : allNetworkLogs;

  for (const entry of networkLogs) {
    console.log(formatNetworkLog(entry));
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
