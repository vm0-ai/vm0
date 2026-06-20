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
import { EventStreamNormalizer } from "../../lib/events/event-stream-normalizer";
import { EventRenderer } from "../../lib/events/event-renderer";
import {
  collectLogItems,
  parsePositiveLogCount,
} from "../../lib/utils/log-pagination";
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
 * Format the firewall tag (name + billable marker) appended to a request line.
 */
function formatFirewallTag(entry: NetworkLogEntry): string {
  if (!entry.firewall_name) return "";
  const billable = entry.firewall_billable ? ` ${chalk.yellow("$")}` : "";
  return ` ${chalk.cyan(`[${entry.firewall_name}${billable}]`)}`;
}

function formatBrowserUserAgentTag(entry: NetworkLogEntry): string {
  return entry.browser_user_agent ? ` ${chalk.magenta("[browser]")}` : "";
}

function formatConnectorDiagnosticInfo(entry: NetworkLogEntry): string {
  const tags: string[] = [];
  if (entry.connector_diagnostic_type) {
    tags.push(entry.connector_diagnostic_type);
  }
  if (entry.connector_diagnostic_reason) {
    tags.push(entry.connector_diagnostic_reason);
  }
  if (
    entry.connector_diagnostic_env_names &&
    entry.connector_diagnostic_env_names.length > 0
  ) {
    tags.push(`env: ${entry.connector_diagnostic_env_names.join(", ")}`);
  }
  if (entry.connector_diagnostic_base) {
    tags.push(`base: ${entry.connector_diagnostic_base}`);
  }
  if (tags.length === 0) return "";
  return ` ${chalk.red(`[connector diagnostic: ${tags.join("; ")}]`)}`;
}

function nonEmptyLogField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function formatNetworkTarget(entry: NetworkLogEntry): string {
  const url = nonEmptyLogField(entry.url);
  if (url) {
    return url;
  }

  const host = nonEmptyLogField(entry.host);
  if (!host) {
    return "unknown";
  }

  return entry.port !== undefined ? `${host}:${entry.port}` : host;
}

/**
 * Format a denied network request (filtered by permission rule)
 */
function formatNetworkDeny(entry: NetworkLogEntry): string {
  const method = entry.method || "???";
  const url = formatNetworkTarget(entry);
  return `[${entry.timestamp}] ${method.padEnd(6)} ${chalk.red.bold("DENY")} ${chalk.dim(url)}${formatFirewallTag(entry)}${formatBrowserUserAgentTag(entry)}${formatConnectorDiagnosticInfo(entry)}`;
}

/**
 * Format a locally blocked network request (vm0/proxy/auth/precondition failure)
 */
function formatNetworkBlock(entry: NetworkLogEntry): string {
  const method = entry.method || "???";
  const target = formatNetworkTarget(entry);
  const error = entry.firewall_error
    ? ` ${chalk.red(entry.firewall_error)}`
    : "";
  return `[${entry.timestamp}] ${method.padEnd(6)} ${chalk.yellow.bold("BLOCK")} ${chalk.dim(target)}${formatFirewallTag(entry)}${formatBrowserUserAgentTag(entry)}${error}${formatConnectorDiagnosticInfo(entry)}${formatAuthInfo(entry)}`;
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
  const url = formatNetworkTarget(entry);
  const error = entry.firewall_error
    ? ` ${chalk.red(entry.firewall_error)}`
    : "";

  let line = `[${entry.timestamp}] ${method.padEnd(6)} ${statusColor(status)} ${latencyColor(latencyMs + "ms")} ${formatBytes(requestSize)}/${formatBytes(responseSize)} ${chalk.dim(url)}${formatFirewallTag(entry)}${formatBrowserUserAgentTag(entry)}${error}${formatConnectorDiagnosticInfo(entry)}${formatAuthInfo(entry)}`;

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
  const dnsResult =
    entry.type === "dns" && entry.dns_result
      ? ` ${chalk.gray("->")} ${chalk.dim(entry.dns_result)}`
      : "";

  return `[${entry.timestamp}] ${chalk.magenta(proto.padEnd(5))}${size} ${chalk.dim(`${host}:${port}`)}${dnsResult}`;
}

/**
 * Format a network log entry
 */
function formatNetworkLog(entry: NetworkLogEntry): string {
  if (entry.action === "BLOCK") return formatNetworkBlock(entry);
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
function renderAgentEvent(
  event: RunEvent,
  renderer: EventRenderer,
  normalizer: EventStreamNormalizer,
  framework: string,
): void {
  const parsedEvents = normalizer.process(
    event.eventData,
    framework,
    new Date(event.createdAt),
  );
  for (const parsed of parsedEvents) {
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
          targetCount = parsePositiveLogCount(options.head!, "--head");
        } else if (isTail) {
          targetCount = parsePositiveLogCount(options.tail!, "--tail");
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
  let framework = "claude-code";
  const events = await collectLogItems<RunEvent>({
    fetchPage: async (request) => {
      const response = await getAgentEvents(runId, request);
      framework = response.framework;
      return {
        items: response.events,
        hasMore: response.hasMore,
        nextCursor: response.nextCursor,
      };
    },
    sinceTime: options.since,
    targetCount: options.targetCount,
    order: options.order,
    pageLimit: PAGE_LIMIT,
  });

  if (events.length === 0) {
    console.log(chalk.yellow("No agent events found for this run"));
    return;
  }

  // Create renderer for log viewing (with timestamps, always verbose)
  const renderer = createLogRenderer(true);
  const normalizer = new EventStreamNormalizer();

  for (const event of events) {
    renderAgentEvent(event, renderer, normalizer, framework);
  }
  for (const parsed of normalizer.flush()) {
    renderer.render(parsed);
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
  const pages: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let remainingBatches =
    options.targetCount === "all" ? undefined : options.targetCount;

  while (true) {
    const limit =
      remainingBatches === undefined
        ? PAGE_LIMIT
        : Math.min(remainingBatches, PAGE_LIMIT);
    const response = await getSystemLog(runId, {
      sinceTime: options.since,
      cursor,
      limit,
      order: options.order,
    });

    const pageHasLog = response.systemLog.length > 0;
    if (pageHasLog) {
      pages.push(response.systemLog);
    }

    if (remainingBatches !== undefined && pageHasLog) {
      remainingBatches -= limit;
      if (remainingBatches <= 0) {
        break;
      }
    }

    const nextCursor = response.nextCursor ?? null;
    if (!response.hasMore || !nextCursor || seenCursors.has(nextCursor)) {
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (pages.length === 0) {
    console.log(chalk.yellow("No system log found for this run"));
    return;
  }

  console.log(pages.join(""));
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
  const metrics = await collectLogItems<TelemetryMetric>({
    fetchPage: async (request) => {
      const response = await getMetrics(runId, request);
      return {
        items: response.metrics,
        hasMore: response.hasMore,
        nextCursor: response.nextCursor,
      };
    },
    sinceTime: options.since,
    targetCount: options.targetCount,
    order: options.order,
    pageLimit: PAGE_LIMIT,
  });

  if (metrics.length === 0) {
    console.log(chalk.yellow("No metrics found for this run"));
    return;
  }

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
  const networkLogs = await collectLogItems<NetworkLogEntry>({
    fetchPage: async (request) => {
      const response = await getNetworkLogs(runId, request);
      return {
        items: response.networkLogs,
        hasMore: response.hasMore,
        nextCursor: response.nextCursor,
      };
    },
    sinceTime: options.since,
    targetCount: options.targetCount,
    order: options.order,
    pageLimit: PAGE_LIMIT,
  });

  if (networkLogs.length === 0) {
    console.log(
      chalk.yellow(
        "No network logs found for this run. Network logs are only captured when using a runner with proxy enabled",
      ),
    );
    return;
  }

  for (const entry of networkLogs) {
    console.log(formatNetworkLog(entry));
  }
}
