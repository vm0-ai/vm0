import { computed, type Computed } from "ccstate";
import type {
  MetricsResponse,
  SystemLogResponse,
} from "@vm0/api-contracts/contracts/runs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { getDatasetName, queryAxiom } from "../external/axiom";
import { escapeAplString } from "../../lib/axiom-apl";
import {
  buildTimeCursorProjection,
  buildTimePaginationFilters,
  buildTimePaginationOrder,
  nextTimeCursor,
  timeCursorBoundary,
} from "./log-pagination";

interface AxiomSystemLogEvent {
  readonly _time: string;
  readonly runId: string;
  readonly userId: string;
  readonly log: string;
}

interface AxiomMetricEvent {
  readonly _time: string;
  readonly runId: string;
  readonly userId: string;
  readonly cpu: number;
  readonly mem_used: number;
  readonly mem_total: number;
  readonly disk_used: number;
  readonly disk_total: number;
}

interface OwnedRunParams {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
}

interface PagedTelemetryParams extends OwnedRunParams {
  readonly since?: number;
  readonly sinceTime?: number;
  readonly cursor?: string;
  readonly limit: number;
  readonly order: "asc" | "desc";
}

function verifyRunOwnership(
  params: OwnedRunParams,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const db = get(db$);
    const [run] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, params.runId),
          eq(agentRuns.userId, params.userId),
          eq(agentRuns.orgId, params.orgId),
        ),
      )
      .limit(1);

    return run !== undefined;
  });
}

export function agentRunSystemLog(
  params: PagedTelemetryParams,
): Computed<Promise<SystemLogResponse | null>> {
  return computed(async (get): Promise<SystemLogResponse | null> => {
    const owned = await get(verifyRunOwnership(params));
    if (!owned) {
      return null;
    }

    const dataset = getDatasetName("sandbox-telemetry-system");
    const previousCursorBoundary = timeCursorBoundary(
      params.cursor,
      params.order,
    );
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${buildTimePaginationFilters(params)}
${buildTimePaginationOrder(params.order)}
${buildTimeCursorProjection()}
| limit ${params.limit + 1}`;

    const events = (
      await get(
        queryAxiom<AxiomSystemLogEvent>(
          apl,
          previousCursorBoundary
            ? { cursor: previousCursorBoundary.tieBreaker }
            : undefined,
        ),
      )
    ).slice();
    const pageHasMore = events.length > params.limit;
    const records = pageHasMore ? events.slice(0, params.limit) : events;
    const nextCursor = nextTimeCursor(
      records,
      pageHasMore,
      params.order,
      previousCursorBoundary,
    );
    const hasMore = nextCursor !== null;

    return {
      systemLog: records
        .map((record) => {
          return record.log;
        })
        .join(""),
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  });
}

export function agentRunMetrics(
  params: PagedTelemetryParams,
): Computed<Promise<MetricsResponse | null>> {
  return computed(async (get): Promise<MetricsResponse | null> => {
    const owned = await get(verifyRunOwnership(params));
    if (!owned) {
      return null;
    }

    const dataset = getDatasetName("sandbox-telemetry-metrics");
    const previousCursorBoundary = timeCursorBoundary(
      params.cursor,
      params.order,
    );
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${buildTimePaginationFilters(params)}
${buildTimePaginationOrder(params.order)}
${buildTimeCursorProjection()}
| limit ${params.limit + 1}`;

    const events = (
      await get(
        queryAxiom<AxiomMetricEvent>(
          apl,
          previousCursorBoundary
            ? { cursor: previousCursorBoundary.tieBreaker }
            : undefined,
        ),
      )
    ).slice();
    const pageHasMore = events.length > params.limit;
    const records = pageHasMore ? events.slice(0, params.limit) : events;
    const nextCursor = nextTimeCursor(
      records,
      pageHasMore,
      params.order,
      previousCursorBoundary,
    );
    const hasMore = nextCursor !== null;

    return {
      metrics: records.map((event) => {
        return {
          ts: event._time,
          cpu: event.cpu,
          mem_used: event.mem_used,
          mem_total: event.mem_total,
          disk_used: event.disk_used,
          disk_total: event.disk_total,
        };
      }),
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    };
  });
}
