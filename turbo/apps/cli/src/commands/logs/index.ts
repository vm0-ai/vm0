import { Command } from "commander";
import chalk from "chalk";
import {
  getAgentEvents,
  getSystemLog,
  getMetrics,
  getNetworkLogs,
  type TelemetryMetric,
  type RunEvent,
  type NetworkLogEntry,
} from "../../lib/api";
import { getApiUrl } from "../../lib/api/config";
import { parseTime } from "../../lib/utils/time-parser";
import { formatBytes } from "../../lib/utils/file-utils";
import { ClaudeEventParser } from "../../lib/events/claude-event-parser";
import { EventRenderer } from "../../lib/events/event-renderer";
import { paginate } from "../../lib/utils/paginate";
import { searchCommand } from "./search";
import { withErrorHandler } from "../../lib/command";

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

  // Transform: www.vm0.ai → app.vm0.ai
  //            vm0.ai → app.vm0.ai
  const parts = hostname.split(".");
  if (parts[0] === "www" || parts[0] === "app" || parts[0] === "platform") {
    parts[0] = "app";
  } else {
    parts.unshift("app");
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
 * Format a denied network request (filtered by permission rule)
 */
function formatNetworkDeny(entry: NetworkLogEntry): string {
  const method = entry.method || "???";
  const url = entry.url || entry.host || "unknown";
  const firewall = entry.firewall_name
    ? ` ${chalk.cyan(`[${entry.firewall_name}]`)}`
    : "";
  return `[${entry.timestamp}] ${method.padEnd(6)} ${chalk.red.bold("DENY")} ${chalk.dim(url)}${firewall}`;
}

/**
 * Format auth resolution info (resolved secrets, refresh/cache status, URL rewrite)
 */
function formatAuthInfo(entry: NetworkLogEntry): string {
  const tags: string[] = [];
  if (entry.auth_url_rewrite) {
    tags.push("url-rewrite");
  }
  if (entry.auth_resolved_secrets && entry.auth_resolved_secrets.length > 0) {
    const refreshedSet = new Set(entry.auth_refreshed_secrets ?? []);
    for (const name of entry.auth_resolved_secrets) {
      if (refreshedSet.has(name)) {
        tags.push(`${name} (refreshed)`);
      } else if (entry.auth_cache_hit) {
        tags.push(`${name} (cached)`);
      } else {
        tags.push(name);
      }
    }
  }
  if (tags.length === 0) return "";
  return ` ${chalk.yellow(`\u2194 ${tags.join(", ")}`)}`;
}

/**
 * Format an ALLOW or ERROR network request with full HTTP details
 */
function formatNetworkRequest(entry: NetworkLogEntry): string {
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
  const firewall = entry.firewall_name
    ? ` ${chalk.cyan(`[${entry.firewall_name}]`)}`
    : "";
  const error = entry.firewall_error
    ? ` ${chalk.red(entry.firewall_error)}`
    : "";

  let line = `[${entry.timestamp}] ${method.padEnd(6)} ${statusColor(status)} ${latencyColor(latencyMs + "ms")} ${formatBytes(requestSize)}/${formatBytes(responseSize)} ${chalk.dim(url)}${firewall}${error}${formatAuthInfo(entry)}`;

  line += formatCaptureFields(entry);

  return line;
}

/**
 * Maximum characters of body content shown in CLI log output.
 */
const BODY_PREVIEW_LENGTH = 200;

/**
 * Format captured body fields (request headers, request body, response body)
 * when present from --capture-network-bodies runs.
 */
function formatCaptureFields(entry: NetworkLogEntry): string {
  let result = "";
  if (entry.request_headers) {
    const hdrs = Object.entries(entry.request_headers)
      .map(([k, v]) => {
        return `${k}: ${v}`;
      })
      .join(", ");
    result += `\n  ${chalk.gray("request_headers:")} ${hdrs}`;
  }
  if (entry.request_body) {
    const truncated = entry.request_body_truncated ? " (truncated)" : "";
    const preview = entry.request_body.slice(0, BODY_PREVIEW_LENGTH);
    const ellipsis =
      entry.request_body.length > BODY_PREVIEW_LENGTH ? "..." : "";
    result += `\n  ${chalk.gray("request_body:")} ${preview}${ellipsis}${truncated}`;
  }
  if (entry.response_body) {
    const truncated = entry.response_body_truncated ? " (truncated)" : "";
    const preview = entry.response_body.slice(0, BODY_PREVIEW_LENGTH);
    const ellipsis =
      entry.response_body.length > BODY_PREVIEW_LENGTH ? "..." : "";
    result += `\n  ${chalk.gray("response_body:")} ${preview}${ellipsis}${truncated}`;
  }
  return result;
}

/**
 * Format a TCP connection log entry
 */
function formatNetworkTcp(entry: NetworkLogEntry): string {
  const host = entry.host || "unknown";
  const port = entry.port || 0;
  const requestSize = entry.request_size || 0;
  const responseSize = entry.response_size || 0;
  const latencyMs = entry.latency_ms || 0;
  const error = entry.error ? ` ${chalk.red(entry.error)}` : "";

  return `[${entry.timestamp}] ${chalk.blue("TCP")}   ${latencyMs}ms ${formatBytes(requestSize)}/${formatBytes(responseSize)} ${chalk.dim(`${host}:${port}`)}${error}`;
}

/**
 * Format a non-TCP/non-HTTP log entry (UDP, ICMP, DNS, etc).
 * These come from iptables LOG via /dev/kmsg or dnsmasq query log.
 */
function formatNetworkOther(entry: NetworkLogEntry): string {
  const proto = (entry.type || "???").toUpperCase();
  const host = entry.host || "unknown";
  const port = entry.port || 0;
  const size = entry.request_size ? ` ${formatBytes(entry.request_size)}` : "";

  return `[${entry.timestamp}] ${chalk.magenta(proto.padEnd(5))}${size} ${chalk.dim(`${host}:${port}`)}`;
}

/**
 * Format a network log entry
 */
function formatNetworkLog(entry: NetworkLogEntry): string {
  if (entry.type === "tcp") return formatNetworkTcp(entry);
  if (entry.type && entry.type !== "http") return formatNetworkOther(entry);
  if (entry.action === "DENY") return formatNetworkDeny(entry);
  return formatNetworkRequest(entry);
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
function renderAgentEvent(event: RunEvent, renderer: EventRenderer): void {
  const eventData = event.eventData as Record<string, unknown>;
  const parsed = ClaudeEventParser.parse(eventData);
  if (parsed) {
    parsed.timestamp = new Date(event.createdAt);
    renderer.render(parsed);
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
    throw new Error(
      "Options --agent, --system, --metrics, and --network are mutually exclusive",
    );
  }

  if (options.system) return "system";
  if (options.metrics) return "metrics";
  if (options.network) return "network";
  return "agent"; // Default
}

export const logsCommand = new Command()
  .name("logs")
  .description("View and search agent run logs")
  .argument("[runId]", "Run ID to fetch logs for")
  .addCommand(searchCommand)
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
    withErrorHandler(
      async (
        runId: string | undefined,
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
        if (!runId) {
          logsCommand.help();
          return;
        }

        const logType = getLogType(options);

        // Validate --tail, --head, and --all are mutually exclusive
        const countModes = [
          options.tail !== undefined,
          options.head !== undefined,
          options.all === true,
        ].filter(Boolean).length;
        if (countModes > 1) {
          throw new Error(
            "Options --tail, --head, and --all are mutually exclusive",
          );
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
      },
    ),
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
  const firstResponse = await getAgentEvents(runId, {
    since: options.since,
    limit: PAGE_LIMIT,
    order: options.order,
  });

  if (firstResponse.events.length === 0) {
    console.log(chalk.yellow("No agent events found for this run"));
    return;
  }

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
        const response = await getAgentEvents(runId, {
          since,
          limit: PAGE_LIMIT,
          order: options.order,
        });
        return { items: response.events, hasMore: response.hasMore };
      },
      getTimestamp: (event) => {
        return new Date(event.createdAt).getTime();
      },
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
    renderAgentEvent(event, renderer);
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

  const response = await getSystemLog(runId, {
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
  const firstResponse = await getMetrics(runId, {
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
        const response = await getMetrics(runId, {
          since,
          limit: PAGE_LIMIT,
          order: options.order,
        });
        return { items: response.metrics, hasMore: response.hasMore };
      },
      getTimestamp: (metric) => {
        return new Date(metric.ts).getTime();
      },
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
  const firstResponse = await getNetworkLogs(runId, {
    since: options.since,
    limit: PAGE_LIMIT,
    order: options.order,
  });

  if (firstResponse.networkLogs.length === 0) {
    console.log(
      chalk.yellow(
        "No network logs found for this run. Network logs are only captured when using a runner with proxy enabled",
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
        const response = await getNetworkLogs(runId, {
          since,
          limit: PAGE_LIMIT,
          order: options.order,
        });
        return { items: response.networkLogs, hasMore: response.hasMore };
      },
      getTimestamp: (entry) => {
        return new Date(entry.timestamp).getTime();
      },
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
