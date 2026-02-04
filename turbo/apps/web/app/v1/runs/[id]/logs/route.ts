/**
 * Public API v1 - Run Logs Endpoint
 *
 * GET /v1/runs/:id/logs - Get unified logs for a run
 */
import { initServices } from "../../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../../src/lib/public-api/handler";
import { publicRunLogsContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../../src/lib/public-api/auth";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/axiom";

interface AxiomSystemLogEvent {
  _time: string;
  runId: string;
  userId: string;
  log: string;
}

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

interface AxiomNetworkEvent {
  _time: string;
  runId: string;
  userId: string;
  method: string;
  url: string;
  status: number;
  duration: number;
}

interface LogEntry {
  timestamp: string;
  type: "agent" | "system" | "network";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

interface TimeFilterParams {
  since?: string;
  until?: string;
  cursor?: string;
  order: "asc" | "desc";
}

/**
 * Build APL time filter clauses
 */
function buildTimeFilters({
  since,
  until,
  cursor,
  order,
}: TimeFilterParams): string {
  const filters: string[] = [];

  if (since) {
    filters.push(
      `| where _time >= datetime("${new Date(since).toISOString()}")`,
    );
  }
  if (until) {
    filters.push(
      `| where _time <= datetime("${new Date(until).toISOString()}")`,
    );
  }
  if (cursor) {
    const op = order === "desc" ? "<" : ">";
    filters.push(
      `| where _time ${op} datetime("${new Date(cursor).toISOString()}")`,
    );
  }

  return filters.join("\n");
}

/**
 * Query logs from a specific Axiom dataset
 */
async function queryLogsFromDataset<T>(
  dataset: string,
  runId: string,
  timeFilterStr: string,
  order: "asc" | "desc",
  limit: number,
): Promise<T[] | null> {
  const apl = `['${dataset}']
| where runId == "${runId}"
${timeFilterStr}
| order by _time ${order}
| limit ${limit + 1}`;

  return queryAxiom<T>(apl);
}

/**
 * Convert system log events to LogEntry format
 */
function convertSystemLogs(
  events: AxiomSystemLogEvent[],
  limit: number,
): LogEntry[] {
  return events.slice(0, limit).map((e) => ({
    timestamp: e._time,
    type: "system" as const,
    level: "info" as const,
    message: e.log,
  }));
}

/**
 * Convert agent events to LogEntry format
 */
function convertAgentLogs(
  events: AxiomAgentEvent[],
  limit: number,
): LogEntry[] {
  return events.slice(0, limit).map((e) => ({
    timestamp: e._time,
    type: "agent" as const,
    level: "info" as const,
    message: `[${e.eventType}] ${JSON.stringify(e.eventData)}`,
    metadata: {
      sequenceNumber: e.sequenceNumber,
      eventType: e.eventType,
      eventData: e.eventData,
    },
  }));
}

/**
 * Convert network events to LogEntry format
 */
function convertNetworkLogs(
  events: AxiomNetworkEvent[],
  limit: number,
): LogEntry[] {
  return events.slice(0, limit).map((e) => ({
    timestamp: e._time,
    type: "network" as const,
    level: e.status >= 400 ? ("error" as const) : ("info" as const),
    message: `${e.method} ${e.url} - ${e.status} (${e.duration}ms)`,
    metadata: {
      method: e.method,
      url: e.url,
      status: e.status,
      duration: e.duration,
    },
  }));
}

/**
 * Fetch logs based on type filter
 */
async function fetchLogs(
  runId: string,
  type: "agent" | "system" | "network" | "all",
  timeFilterStr: string,
  order: "asc" | "desc",
  limit: number,
): Promise<LogEntry[]> {
  const logs: LogEntry[] = [];

  if (type === "all" || type === "system") {
    const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_SYSTEM);
    const events = await queryLogsFromDataset<AxiomSystemLogEvent>(
      dataset,
      runId,
      timeFilterStr,
      order,
      limit,
    );
    if (events) {
      logs.push(...convertSystemLogs(events, limit));
    }
  }

  if (type === "all" || type === "agent") {
    const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
    const events = await queryLogsFromDataset<AxiomAgentEvent>(
      dataset,
      runId,
      timeFilterStr,
      order,
      limit,
    );
    if (events) {
      logs.push(...convertAgentLogs(events, limit));
    }
  }

  if (type === "all" || type === "network") {
    const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
    const events = await queryLogsFromDataset<AxiomNetworkEvent>(
      dataset,
      runId,
      timeFilterStr,
      order,
      limit,
    );
    if (events) {
      logs.push(...convertNetworkLogs(events, limit));
    }
  }

  return logs;
}

/**
 * Sort logs by timestamp
 */
function sortLogs(logs: LogEntry[], order: "asc" | "desc"): void {
  logs.sort((a, b) => {
    const cmp =
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    return order === "desc" ? -cmp : cmp;
  });
}

const router = tsr.router(publicRunLogsContract, {
  getLogs: async ({ params, query, headers }) => {
    initServices();

    const auth = await authenticatePublicApi(headers.authorization);
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Verify run exists and belongs to user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, params.id))
      .limit(1);

    if (!run || run.userId !== auth.userId) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such run: '${params.id}'`,
          },
        },
      };
    }

    const { type, since, until, order, limit, cursor } = query;
    const effectiveLimit = limit ?? 100;

    const timeFilterStr = buildTimeFilters({ since, until, cursor, order });
    const logs = await fetchLogs(
      params.id,
      type,
      timeFilterStr,
      order,
      effectiveLimit,
    );
    sortLogs(logs, order);

    // Apply limit and determine pagination
    const hasMore = logs.length > effectiveLimit;
    const data = hasMore ? logs.slice(0, effectiveLimit) : logs;
    const nextCursor =
      hasMore && data.length > 0 ? data[data.length - 1]!.timestamp : null;

    return {
      status: 200 as const,
      body: {
        data,
        pagination: {
          hasMore,
          nextCursor,
        },
      },
    };
  },
});

const handler = createPublicApiHandler(publicRunLogsContract, router);

export { handler as GET };
