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

const router = tsr.router(publicRunLogsContract, {
  getLogs: async ({ params, query }) => {
    initServices();

    const auth = await authenticatePublicApi();
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

    if (!run) {
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

    // Verify ownership
    if (run.userId !== auth.userId) {
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

    // Build time filters for APL
    const timeFilters: string[] = [];
    if (since) {
      timeFilters.push(
        `| where _time >= datetime("${new Date(since).toISOString()}")`,
      );
    }
    if (until) {
      timeFilters.push(
        `| where _time <= datetime("${new Date(until).toISOString()}")`,
      );
    }
    // Cursor is a timestamp for cursor-based pagination
    if (cursor) {
      const op = order === "desc" ? "<" : ">";
      timeFilters.push(
        `| where _time ${op} datetime("${new Date(cursor).toISOString()}")`,
      );
    }
    const timeFilterStr = timeFilters.join("\n");

    const logs: LogEntry[] = [];

    // Query system logs if requested
    if (type === "all" || type === "system") {
      const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_SYSTEM);
      const apl = `['${dataset}']
| where runId == "${params.id}"
${timeFilterStr}
| order by _time ${order}
| limit ${effectiveLimit + 1}`;

      const events = await queryAxiom<AxiomSystemLogEvent>(apl);
      if (events) {
        for (const e of events.slice(0, effectiveLimit)) {
          logs.push({
            timestamp: e._time,
            type: "system",
            level: "info",
            message: e.log,
          });
        }
      }
    }

    // Query agent events if requested
    if (type === "all" || type === "agent") {
      const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
      const apl = `['${dataset}']
| where runId == "${params.id}"
${timeFilterStr}
| order by _time ${order}
| limit ${effectiveLimit + 1}`;

      const events = await queryAxiom<AxiomAgentEvent>(apl);
      if (events) {
        for (const e of events.slice(0, effectiveLimit)) {
          logs.push({
            timestamp: e._time,
            type: "agent",
            level: "info",
            message: `[${e.eventType}] ${JSON.stringify(e.eventData)}`,
            metadata: {
              sequenceNumber: e.sequenceNumber,
              eventType: e.eventType,
              eventData: e.eventData,
            },
          });
        }
      }
    }

    // Query network events if requested
    if (type === "all" || type === "network") {
      const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
      const apl = `['${dataset}']
| where runId == "${params.id}"
${timeFilterStr}
| order by _time ${order}
| limit ${effectiveLimit + 1}`;

      const events = await queryAxiom<AxiomNetworkEvent>(apl);
      if (events) {
        for (const e of events.slice(0, effectiveLimit)) {
          logs.push({
            timestamp: e._time,
            type: "network",
            level: e.status >= 400 ? "error" : "info",
            message: `${e.method} ${e.url} - ${e.status} (${e.duration}ms)`,
            metadata: {
              method: e.method,
              url: e.url,
              status: e.status,
              duration: e.duration,
            },
          });
        }
      }
    }

    // Sort combined logs by timestamp
    logs.sort((a, b) => {
      const cmp =
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      return order === "desc" ? -cmp : cmp;
    });

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
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      },
    };
  },
});

const handler = createPublicApiHandler(publicRunLogsContract, router);

export { handler as GET };
