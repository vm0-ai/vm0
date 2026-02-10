import "server-only";
import { eq, gt, asc, desc, and } from "drizzle-orm";
import { sandboxTelemetry } from "../../db/schema/sandbox-telemetry";
import { agentRunEventsLocal } from "../../db/schema/agent-run-events-local";
import { logger } from "../logger";

const log = logger("telemetry:local");

// ============ Types ============

interface TelemetryData {
  systemLog?: string;
  metrics?: MetricEntry[];
  networkLogs?: NetworkLogEntry[];
}

interface MetricEntry {
  ts: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

interface NetworkLogEntry {
  timestamp: string;
  mode?: "mitm" | "sni";
  action?: "ALLOW" | "DENY";
  host?: string;
  port?: number;
  rule_matched?: string | null;
  method?: string;
  url?: string;
  status?: number;
  latency_ms?: number;
  request_size?: number;
  response_size?: number;
}

interface AgentEventInput {
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

// ============ Write Operations ============

/**
 * Store telemetry data (system log, metrics, network logs) to PostgreSQL.
 */
export async function storeTelemetry(
  runId: string,
  data: TelemetryData,
): Promise<void> {
  try {
    await globalThis.services.db.insert(sandboxTelemetry).values({
      runId,
      data,
    });
    log.debug(
      `Stored telemetry for run ${runId}: ` +
        `log=${data.systemLog?.length ?? 0}B ` +
        `metrics=${data.metrics?.length ?? 0} ` +
        `network=${data.networkLogs?.length ?? 0}`,
    );
  } catch (error) {
    log.error(`Failed to store telemetry for run ${runId}:`, error);
  }
}

/**
 * Store agent events to PostgreSQL.
 */
export async function storeAgentEvents(
  runId: string,
  events: AgentEventInput[],
): Promise<void> {
  if (events.length === 0) return;

  try {
    const rows = events.map((event) => ({
      runId,
      sequenceNumber: event.sequenceNumber,
      eventType: event.eventType,
      eventData: event.eventData,
    }));

    await globalThis.services.db.insert(agentRunEventsLocal).values(rows);
    log.debug(`Stored ${events.length} agent events for run ${runId}`);
  } catch (error) {
    log.error(`Failed to store agent events for run ${runId}:`, error);
  }
}

// ============ Read Operations: System Log ============

export async function querySystemLog(
  runId: string,
  options: { since?: number; limit: number; order: "asc" | "desc" },
): Promise<{ systemLog: string; hasMore: boolean }> {
  const sinceFilter = options.since
    ? and(
        eq(sandboxTelemetry.runId, runId),
        gt(sandboxTelemetry.createdAt, new Date(options.since)),
      )
    : eq(sandboxTelemetry.runId, runId);

  const orderBy =
    options.order === "asc"
      ? asc(sandboxTelemetry.createdAt)
      : desc(sandboxTelemetry.createdAt);

  // Fetch limit+1 records to detect hasMore
  const records = await globalThis.services.db
    .select({ data: sandboxTelemetry.data })
    .from(sandboxTelemetry)
    .where(sinceFilter)
    .orderBy(orderBy)
    .limit(options.limit + 1);

  const hasMore = records.length > options.limit;
  const sliced = hasMore ? records.slice(0, options.limit) : records;

  const systemLog = sliced
    .map((r) => (r.data as TelemetryData).systemLog ?? "")
    .join("");

  return { systemLog, hasMore };
}

// ============ Read Operations: Metrics ============

export async function queryMetrics(
  runId: string,
  options: { since?: number; limit: number; order: "asc" | "desc" },
): Promise<{ metrics: MetricEntry[]; hasMore: boolean }> {
  const sinceFilter = options.since
    ? and(
        eq(sandboxTelemetry.runId, runId),
        gt(sandboxTelemetry.createdAt, new Date(options.since)),
      )
    : eq(sandboxTelemetry.runId, runId);

  const records = await globalThis.services.db
    .select({ data: sandboxTelemetry.data })
    .from(sandboxTelemetry)
    .where(sinceFilter)
    .orderBy(asc(sandboxTelemetry.createdAt));

  // Flatten all metrics from batched records
  const allMetrics: MetricEntry[] = [];
  for (const record of records) {
    const data = record.data as TelemetryData;
    if (data.metrics) {
      allMetrics.push(...data.metrics);
    }
  }

  // Sort and paginate
  if (options.order === "desc") {
    allMetrics.reverse();
  }

  const hasMore = allMetrics.length > options.limit;
  const metrics = hasMore ? allMetrics.slice(0, options.limit) : allMetrics;

  return { metrics, hasMore };
}

// ============ Read Operations: Network Logs ============

export async function queryNetworkLogs(
  runId: string,
  options: { since?: number; limit: number; order: "asc" | "desc" },
): Promise<{ networkLogs: NetworkLogEntry[]; hasMore: boolean }> {
  const sinceFilter = options.since
    ? and(
        eq(sandboxTelemetry.runId, runId),
        gt(sandboxTelemetry.createdAt, new Date(options.since)),
      )
    : eq(sandboxTelemetry.runId, runId);

  const records = await globalThis.services.db
    .select({ data: sandboxTelemetry.data })
    .from(sandboxTelemetry)
    .where(sinceFilter)
    .orderBy(asc(sandboxTelemetry.createdAt));

  // Flatten all network logs from batched records
  const allNetworkLogs: NetworkLogEntry[] = [];
  for (const record of records) {
    const data = record.data as TelemetryData;
    if (data.networkLogs) {
      allNetworkLogs.push(...data.networkLogs);
    }
  }

  // Sort and paginate
  if (options.order === "desc") {
    allNetworkLogs.reverse();
  }

  const hasMore = allNetworkLogs.length > options.limit;
  const networkLogs = hasMore
    ? allNetworkLogs.slice(0, options.limit)
    : allNetworkLogs;

  return { networkLogs, hasMore };
}

// ============ Read Operations: Agent Events ============

/**
 * Query agent events by sequence number (used by polling endpoint).
 */
export async function queryAgentEventsBySequence(
  runId: string,
  since: number,
  limit: number,
): Promise<
  Array<{
    sequenceNumber: number;
    eventType: string;
    eventData: Record<string, unknown>;
    createdAt: Date;
  }>
> {
  const rows = await globalThis.services.db
    .select({
      sequenceNumber: agentRunEventsLocal.sequenceNumber,
      eventType: agentRunEventsLocal.eventType,
      eventData: agentRunEventsLocal.eventData,
      createdAt: agentRunEventsLocal.createdAt,
    })
    .from(agentRunEventsLocal)
    .where(
      and(
        eq(agentRunEventsLocal.runId, runId),
        gt(agentRunEventsLocal.sequenceNumber, since),
      ),
    )
    .orderBy(asc(agentRunEventsLocal.sequenceNumber))
    .limit(limit);

  return rows.map((r) => ({
    sequenceNumber: r.sequenceNumber,
    eventType: r.eventType,
    eventData: r.eventData as Record<string, unknown>,
    createdAt: r.createdAt,
  }));
}

/**
 * Query agent events by time (used by telemetry/agent endpoint for platform UI).
 */
export async function queryAgentEventsByTime(
  runId: string,
  options: { since?: number; limit: number; order: "asc" | "desc" },
): Promise<{
  events: Array<{
    sequenceNumber: number;
    eventType: string;
    eventData: Record<string, unknown>;
    createdAt: string;
  }>;
  hasMore: boolean;
}> {
  const sinceFilter = options.since
    ? and(
        eq(agentRunEventsLocal.runId, runId),
        gt(agentRunEventsLocal.createdAt, new Date(options.since)),
      )
    : eq(agentRunEventsLocal.runId, runId);

  const orderBy =
    options.order === "asc"
      ? asc(agentRunEventsLocal.createdAt)
      : desc(agentRunEventsLocal.createdAt);

  const rows = await globalThis.services.db
    .select({
      sequenceNumber: agentRunEventsLocal.sequenceNumber,
      eventType: agentRunEventsLocal.eventType,
      eventData: agentRunEventsLocal.eventData,
      createdAt: agentRunEventsLocal.createdAt,
    })
    .from(agentRunEventsLocal)
    .where(sinceFilter)
    .orderBy(orderBy)
    .limit(options.limit + 1);

  const hasMore = rows.length > options.limit;
  const sliced = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    events: sliced.map((r) => ({
      sequenceNumber: r.sequenceNumber,
      eventType: r.eventType,
      eventData: r.eventData as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    })),
    hasMore,
  };
}
