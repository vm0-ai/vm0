import { computed, type Computed } from "ccstate";
import type {
  EventsResponse,
  MetricsResponse,
  RunEvent,
  RunResult,
  RunState,
  RunStatus,
  SystemLogResponse,
} from "@vm0/api-contracts/contracts/runs";
import { formatClaudeProviderOverloadedRunError } from "@vm0/api-contracts/contracts/errors";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { getDatasetName, queryAxiom } from "../external/axiom";
import {
  getAgentEventPageWatermarkTarget,
  waitForRunEventWatermarkVisible,
} from "../../lib/agent-event-visibility";
import { escapeAplString } from "../../lib/axiom-apl";
import {
  buildTimeCursorProjection,
  buildTimePaginationFilters,
  buildTimePaginationOrder,
  nextTimeCursor,
  timeCursorBoundary,
} from "./log-pagination";
import { runContextCliAgentType } from "./run-context-framework.service";

interface AgentComposeContent {
  readonly agent?: { readonly framework?: string };
  readonly agents?: Record<string, { readonly framework?: string } | undefined>;
}

interface AxiomAgentEvent {
  readonly _time: string;
  readonly runId: string;
  readonly userId: string;
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly eventData: Record<string, unknown>;
}

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

interface EventsParams extends OwnedRunParams {
  readonly since: number;
  readonly limit: number;
}

interface PagedTelemetryParams extends OwnedRunParams {
  readonly since?: number;
  readonly sinceTime?: number;
  readonly cursor?: string;
  readonly limit: number;
  readonly order: "asc" | "desc";
}

interface RunWithCompose {
  readonly status: string;
  readonly result: unknown;
  readonly error: string | null;
  readonly lastEventSequence: number | null;
  readonly composeContent: unknown;
  readonly selectedModel: string | null;
}

function extractFramework(composeContent: unknown): string {
  const content = composeContent as AgentComposeContent | null | undefined;
  if (content?.agent?.framework) {
    return content.agent.framework;
  }

  const agents = content?.agents;
  const firstAgentKey = agents ? Object.keys(agents)[0] : undefined;
  return firstAgentKey
    ? (agents?.[firstAgentKey]?.framework ?? "claude-code")
    : "claude-code";
}

function filterConsecutiveEvents(
  events: readonly AxiomAgentEvent[],
  since: number,
): AxiomAgentEvent[] {
  const consecutiveEvents: AxiomAgentEvent[] = [];
  let expectedSequence = since + 1;

  for (const event of events) {
    if (event.sequenceNumber < expectedSequence) {
      continue;
    }
    if (event.sequenceNumber !== expectedSequence) {
      break;
    }
    consecutiveEvents.push(event);
    expectedSequence++;
  }

  return consecutiveEvents;
}

function toRunEvent(event: AxiomAgentEvent): RunEvent {
  return {
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    eventData: event.eventData,
    createdAt: event._time,
  };
}

function buildRunState(run: RunWithCompose): RunState {
  const state: RunState = {
    status: run.status as RunStatus,
  };

  if (run.status === "completed" && run.result) {
    state.result = run.result as RunResult;
  }

  if (run.status === "failed" && run.error) {
    state.error =
      formatClaudeProviderOverloadedRunError({
        message: run.error,
        selectedModel: run.selectedModel,
      }) ?? run.error;
  }

  if (run.lastEventSequence !== null) {
    state.lastEventSequence = run.lastEventSequence;
  }

  return state;
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

export function agentRunEvents(
  params: EventsParams,
): Computed<Promise<EventsResponse | null>> {
  return computed(async (get): Promise<EventsResponse | null> => {
    const db = get(db$);
    const [runWithCompose] = await db
      .select({
        status: agentRuns.status,
        result: agentRuns.result,
        error: agentRuns.error,
        lastEventSequence: agentRuns.lastEventSequence,
        composeContent: agentComposeVersions.content,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .where(
        and(
          eq(agentRuns.id, params.runId),
          eq(agentRuns.userId, params.userId),
          eq(agentRuns.orgId, params.orgId),
        ),
      )
      .limit(1);

    if (!runWithCompose) {
      return null;
    }

    const watermarkTarget = getAgentEventPageWatermarkTarget(
      runWithCompose.lastEventSequence,
      params.since,
      params.limit,
    );
    if (watermarkTarget !== null) {
      await waitForRunEventWatermarkVisible(params.runId, watermarkTarget);
    }

    const dataset = getDatasetName("agent-run-events");
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
| where sequenceNumber > ${params.since}
| order by sequenceNumber asc
| limit ${params.limit}`;

    const rawEvents = (
      await get(
        queryAxiom<AxiomAgentEvent>(
          apl,
          watermarkTarget !== null ? { noCache: true } : undefined,
        ),
      )
    ).slice();
    const events = filterConsecutiveEvents(rawEvents, params.since);
    const hasMore =
      events.length < rawEvents.length || rawEvents.length === params.limit;
    const nextSequence =
      events.length > 0
        ? events[events.length - 1]!.sequenceNumber
        : params.since;

    return {
      events: events.map(toRunEvent),
      hasMore,
      nextSequence,
      run: buildRunState(runWithCompose),
      framework:
        (await get(runContextCliAgentType(params.runId))) ??
        extractFramework(runWithCompose.composeContent),
    };
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
