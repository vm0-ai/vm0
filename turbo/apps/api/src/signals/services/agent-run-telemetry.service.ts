import { computed, type Computed } from "ccstate";
import type {
  AgentEventsResponse,
  AxiomNetworkEvent,
  EventsResponse,
  MetricsResponse,
  NetworkLogsResponse,
  RunEvent,
  RunResult,
  RunState,
  RunStatus,
  SystemLogResponse,
  TelemetryMetric,
  TelemetryResponse,
} from "@vm0/api-contracts/contracts/runs";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { sandboxTelemetry } from "@vm0/db/schema/sandbox-telemetry";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { getDatasetName, queryAxiom } from "../external/axiom";
import {
  getAgentEventPageWatermarkTarget,
  waitForRunEventWatermarkVisible,
} from "../../lib/agent-event-visibility";
import { escapeAplString } from "../../lib/axiom-apl";

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

interface TelemetryData {
  readonly systemLog?: string;
  readonly metrics?: readonly TelemetryMetric[];
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
  readonly limit: number;
  readonly order: "asc" | "desc";
}

interface RunWithCompose {
  readonly status: string;
  readonly result: unknown;
  readonly error: string | null;
  readonly lastEventSequence: number | null;
  readonly composeContent: unknown;
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
    state.error = run.error;
  }

  if (run.lastEventSequence !== null) {
    state.lastEventSequence = run.lastEventSequence;
  }

  return state;
}

function systemTelemetrySinceFilter(since: number | undefined): string {
  return since
    ? `| where _time > datetime("${new Date(since).toISOString()}")`
    : "";
}

function optionalAxiomField<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function optionalAxiomStringRecord(
  value: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function networkLogFromAxiom(event: AxiomNetworkEvent) {
  return {
    timestamp: event._time,
    type: optionalAxiomField(event.type),
    action: optionalAxiomField(event.action),
    host: optionalAxiomField(event.host),
    port: optionalAxiomField(event.port),
    method: optionalAxiomField(event.method),
    url: optionalAxiomField(event.url),
    status: optionalAxiomField(event.status),
    latency_ms: optionalAxiomField(event.latency_ms),
    request_size: optionalAxiomField(event.request_size),
    response_size: optionalAxiomField(event.response_size),
    dns_event: optionalAxiomField(event.dns_event),
    dns_query_type: optionalAxiomField(event.dns_query_type),
    dns_result: optionalAxiomField(event.dns_result),
    dns_serial: optionalAxiomField(event.dns_serial),
    firewall_base: optionalAxiomField(event.firewall_base),
    firewall_name: optionalAxiomField(event.firewall_name),
    firewall_permission: optionalAxiomField(event.firewall_permission),
    firewall_rule_match: optionalAxiomField(event.firewall_rule_match),
    firewall_params: optionalAxiomStringRecord(event.firewall_params),
    firewall_billable: optionalAxiomField(event.firewall_billable),
    firewall_error: optionalAxiomField(event.firewall_error),
    auth_resolved_secrets: optionalAxiomField(event.auth_resolved_secrets),
    auth_refreshed_connectors: optionalAxiomField(
      event.auth_refreshed_connectors,
    ),
    auth_refreshed_secrets: optionalAxiomField(event.auth_refreshed_secrets),
    auth_cache_hit: optionalAxiomField(event.auth_cache_hit),
    auth_url_rewrite: optionalAxiomField(event.auth_url_rewrite),
    error: optionalAxiomField(event.error),
    request_headers: optionalAxiomStringRecord(event.request_headers),
    request_body: optionalAxiomField(event.request_body),
    request_body_encoding: optionalAxiomField(event.request_body_encoding),
    request_body_truncated: optionalAxiomField(event.request_body_truncated),
    response_headers: optionalAxiomStringRecord(event.response_headers),
    response_body: optionalAxiomField(event.response_body),
    response_body_encoding: optionalAxiomField(event.response_body_encoding),
    response_body_truncated: optionalAxiomField(event.response_body_truncated),
  };
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
      })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
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
        queryAxiom(
          apl,
          watermarkTarget !== null ? { noCache: true } : undefined,
        ),
      )
    ).slice() as unknown as AxiomAgentEvent[];
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
      framework: extractFramework(runWithCompose.composeContent),
    };
  });
}

export function agentRunTelemetry(
  params: OwnedRunParams,
): Computed<Promise<TelemetryResponse | null>> {
  return computed(async (get): Promise<TelemetryResponse | null> => {
    const db = get(db$);
    const owned = await get(verifyRunOwnership(params));
    if (!owned) {
      return null;
    }

    const telemetryRecords = await db
      .select({ data: sandboxTelemetry.data })
      .from(sandboxTelemetry)
      .where(eq(sandboxTelemetry.runId, params.runId))
      .orderBy(sandboxTelemetry.createdAt);

    let systemLog = "";
    const metrics: TelemetryMetric[] = [];

    for (const record of telemetryRecords) {
      const data = record.data as TelemetryData;
      if (data.systemLog) {
        systemLog += data.systemLog;
      }
      if (data.metrics) {
        metrics.push(...data.metrics);
      }
    }

    return { systemLog, metrics };
  });
}

export function agentRunAgentEvents(
  params: PagedTelemetryParams,
): Computed<Promise<AgentEventsResponse | null>> {
  return computed(async (get): Promise<AgentEventsResponse | null> => {
    const db = get(db$);
    const [runWithCompose] = await db
      .select({
        id: agentRuns.id,
        lastEventSequence: agentRuns.lastEventSequence,
        composeContent: agentComposeVersions.content,
      })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
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

    const watermarkTarget =
      params.order === "asc"
        ? getAgentEventPageWatermarkTarget(
            runWithCompose.lastEventSequence,
            params.since,
            params.limit + 1,
          )
        : params.since !== undefined &&
            runWithCompose.lastEventSequence !== null &&
            params.since >= runWithCompose.lastEventSequence
          ? null
          : runWithCompose.lastEventSequence;
    if (watermarkTarget !== null) {
      await waitForRunEventWatermarkVisible(params.runId, watermarkTarget);
    }

    const sinceFilter =
      params.since !== undefined
        ? `| where sequenceNumber > ${params.since}`
        : "";
    const dataset = getDatasetName("agent-run-events");
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${sinceFilter}
| order by sequenceNumber ${params.order}
| limit ${params.limit + 1}`;

    const events = (
      await get(
        queryAxiom(
          apl,
          watermarkTarget !== null ? { noCache: true } : undefined,
        ),
      )
    ).slice() as unknown as AxiomAgentEvent[];
    const hasMore = events.length > params.limit;
    const resultEvents = hasMore ? events.slice(0, params.limit) : events;

    return {
      events: resultEvents.map(toRunEvent),
      hasMore,
      framework: extractFramework(runWithCompose.composeContent),
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
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${systemTelemetrySinceFilter(params.since)}
| order by _time ${params.order}
| limit ${params.limit + 1}`;

    const events = (
      await get(queryAxiom(apl))
    ).slice() as unknown as AxiomSystemLogEvent[];
    const hasMore = events.length > params.limit;
    const records = hasMore ? events.slice(0, params.limit) : events;

    return {
      systemLog: records
        .map((record) => {
          return record.log;
        })
        .join(""),
      hasMore,
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
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${systemTelemetrySinceFilter(params.since)}
| order by _time ${params.order}
| limit ${params.limit + 1}`;

    const events = (
      await get(queryAxiom(apl))
    ).slice() as unknown as AxiomMetricEvent[];
    const hasMore = events.length > params.limit;
    const records = hasMore ? events.slice(0, params.limit) : events;

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
    };
  });
}

export function agentRunNetworkLogs(
  params: PagedTelemetryParams,
): Computed<Promise<NetworkLogsResponse | null>> {
  return computed(async (get): Promise<NetworkLogsResponse | null> => {
    const owned = await get(verifyRunOwnership(params));
    if (!owned) {
      return null;
    }

    const dataset = getDatasetName("sandbox-telemetry-network");
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.runId)}"
${systemTelemetrySinceFilter(params.since)}
| order by _time ${params.order}
| limit ${params.limit + 1}`;

    const events = (
      await get(queryAxiom(apl))
    ).slice() as unknown as AxiomNetworkEvent[];
    const hasMore = events.length > params.limit;
    const records = hasMore ? events.slice(0, params.limit) : events;

    return {
      networkLogs: records.map(networkLogFromAxiom),
      hasMore,
    };
  });
}
