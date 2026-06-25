import { computed, type Computed } from "ccstate";
import {
  triggerSourceSchema,
  type LogDetail,
  type LogEntry,
  type LogStatus,
  type LogsFilters,
  type TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
import {
  MAX_EVENT_SEQUENCE_NUMBER,
  type LogsSearchResponse,
  type RunEvent,
} from "@vm0/api-contracts/contracts/runs";
import { isSupportedFramework } from "@vm0/core/frameworks";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { conversations } from "@vm0/db/schema/conversation";
import { alias } from "drizzle-orm/pg-core";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  lt,
  or,
  type SQL,
} from "drizzle-orm";

import { db$, type Db } from "../external/db";
import { getDatasetName, queryAxiom } from "../external/axiom";
import { escapeAplString } from "../../lib/axiom-apl";
import { now } from "../../lib/time";

type ServiceDb = Pick<Db, "select" | "selectDistinct">;

const triggerAgentAlias = alias(zeroAgents, "trigger_agent");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const AXIOM_RUN_ID_FILTER_CHUNK_SIZE = 500;
const AXIOM_SEARCH_QUERY_CONCURRENCY = 4;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractFramework(composeContent: unknown): string | null {
  if (
    !composeContent ||
    typeof composeContent !== "object" ||
    Array.isArray(composeContent)
  ) {
    return null;
  }

  const agents = (composeContent as { readonly agents?: unknown }).agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return null;
  }

  const [firstAgent] = Object.values(agents);
  if (
    !firstAgent ||
    typeof firstAgent !== "object" ||
    Array.isArray(firstAgent)
  ) {
    return null;
  }

  const framework = (firstAgent as { readonly framework?: unknown }).framework;
  return typeof framework === "string" && isSupportedFramework(framework)
    ? framework
    : null;
}

function normalizeTriggerSource(
  source: string | null | undefined,
): TriggerSource | null {
  const parsed = triggerSourceSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
}

function buildCursorCondition(cursor: string): SQL | null {
  const separatorIndex = cursor.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex >= cursor.length - 1) {
    return null;
  }

  const cursorTime = cursor.slice(0, separatorIndex);
  const cursorId = cursor.slice(separatorIndex + 1);
  const cursorDate = new Date(cursorTime);
  if (!Number.isFinite(cursorDate.getTime()) || !UUID_PATTERN.test(cursorId)) {
    return null;
  }

  return or(
    lt(agentRuns.createdAt, cursorDate),
    and(eq(agentRuns.createdAt, cursorDate), lt(agentRuns.id, cursorId)),
  )!;
}

interface LogsListParams {
  userId: string;
  orgId: string;
  cursor?: string;
  limit?: number;
  search?: string;
  agentId?: string;
  name?: string;
  since?: number;
  status?: LogStatus;
  triggerSource?: TriggerSource;
  automationId?: string;
}

function buildAgentFilterConditions(params: {
  agentId?: string;
  name?: string;
  search?: string;
}): SQL[] {
  const conditions: SQL[] = [];

  if (params.agentId) {
    conditions.push(eq(zeroAgents.id, params.agentId));
  } else if (params.name) {
    conditions.push(eq(agentComposes.name, params.name));
  } else if (params.search) {
    conditions.push(ilike(agentComposes.name, `%${params.search}%`));
  }

  return conditions;
}

interface LogsListData {
  data: LogEntry[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    totalPages: number;
  };
  filters: LogsFilters;
}

export function zeroLogsList(
  params: LogsListParams,
): Computed<Promise<LogsListData>> {
  return computed(async (get): Promise<LogsListData> => {
    const db = get(db$);
    const limit = params.limit ?? 20;

    const conditions: SQL[] = [
      eq(agentRuns.userId, params.userId),
      eq(agentRuns.orgId, params.orgId),
    ];

    if (params.cursor) {
      const cursorCondition = buildCursorCondition(params.cursor);
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    conditions.push(...buildAgentFilterConditions(params));

    if (params.since) {
      conditions.push(gte(agentRuns.createdAt, new Date(params.since)));
    }
    if (params.status) {
      conditions.push(eq(agentRuns.status, params.status));
    }
    if (params.triggerSource) {
      conditions.push(eq(zeroRuns.triggerSource, params.triggerSource));
    }
    if (params.automationId) {
      conditions.push(eq(zeroRuns.automationId, params.automationId));
    }

    const whereClause = and(...conditions);

    // Main query, count, and filters in parallel
    const [rows, totalCount, filters] = await Promise.all([
      db
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          prompt: agentRuns.prompt,
          createdAt: agentRuns.createdAt,
          startedAt: agentRuns.startedAt,
          completedAt: agentRuns.completedAt,
          triggerSource: zeroRuns.triggerSource,
          automationId: zeroRuns.automationId,
          agentId: zeroAgents.id,
          composeName: agentComposes.name,
          composeContent: agentComposeVersions.content,
          displayName: zeroAgents.displayName,
          triggerAgentName: triggerAgentAlias.displayName,
          cliAgentSessionId: conversations.cliAgentSessionId,
        })
        .from(agentRuns)
        .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
        .leftJoin(
          agentComposeVersions,
          eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
        )
        .leftJoin(
          agentComposes,
          eq(agentComposeVersions.composeId, agentComposes.id),
        )
        .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
        .leftJoin(
          triggerAgentAlias,
          eq(zeroRuns.triggerAgentId, triggerAgentAlias.id),
        )
        .leftJoin(conversations, eq(agentRuns.id, conversations.runId))
        .where(whereClause)
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .limit(limit + 1),
      getLogsTotalCount(db, params),
      getAvailableFilters(db, params.userId, params.orgId),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1]!;
      nextCursor = `${lastItem.createdAt.toISOString()}|${lastItem.id}`;
    }

    return {
      data: data.map((run) => {
        return {
          id: run.id,
          sessionId: run.cliAgentSessionId ?? null,
          agentId: run.agentId ?? null,
          displayName: run.displayName ?? null,
          framework: extractFramework(run.composeContent),
          triggerSource: normalizeTriggerSource(run.triggerSource ?? "cli"),
          triggerAgentName: run.triggerAgentName ?? null,
          automationId: run.automationId ?? null,
          status: run.status as LogStatus,
          prompt: run.prompt,
          createdAt: run.createdAt.toISOString(),
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
        };
      }),
      pagination: {
        hasMore,
        nextCursor,
        totalPages,
      },
      filters,
    };
  });
}

async function getLogsTotalCount(
  db: ServiceDb,
  params: LogsListParams,
): Promise<number> {
  const conditions: SQL[] = [
    eq(agentRuns.userId, params.userId),
    eq(agentRuns.orgId, params.orgId),
  ];

  conditions.push(...buildAgentFilterConditions(params));

  if (params.since) {
    conditions.push(gte(agentRuns.createdAt, new Date(params.since)));
  }
  if (params.status) {
    conditions.push(eq(agentRuns.status, params.status));
  }
  if (params.triggerSource) {
    conditions.push(eq(zeroRuns.triggerSource, params.triggerSource));
  }
  if (params.automationId) {
    conditions.push(eq(zeroRuns.automationId, params.automationId));
  }

  const [result] = await db
    .select({ count: count() })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(and(...conditions));

  return result?.count ?? 0;
}

async function getAvailableFilters(
  db: ServiceDb,
  userId: string,
  orgId: string,
): Promise<LogsFilters> {
  const baseConditions = [
    eq(agentRuns.userId, userId),
    eq(agentRuns.orgId, orgId),
  ];

  const [statusRows, sourceRows, agentRows] = await Promise.all([
    db
      .selectDistinct({ status: agentRuns.status })
      .from(agentRuns)
      .where(and(...baseConditions)),
    db
      .selectDistinct({ triggerSource: zeroRuns.triggerSource })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .where(and(...baseConditions)),
    db
      .selectDistinct({ agentId: zeroAgents.id })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .leftJoin(
        agentComposes,
        eq(agentComposeVersions.composeId, agentComposes.id),
      )
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(and(...baseConditions, isNotNull(zeroAgents.id))),
  ]);

  const statuses = statusRows
    .map((r) => {
      return r.status;
    })
    .filter((s): s is LogStatus => {
      return [
        "queued",
        "pending",
        "running",
        "completed",
        "failed",
        "timeout",
        "cancelled",
      ].includes(s as string);
    });

  const sources = sourceRows
    .map((r) => {
      return r.triggerSource;
    })
    .filter((s): s is TriggerSource => {
      return triggerSourceSchema.safeParse(s).success;
    });

  const agents = agentRows
    .map((r) => {
      return r.agentId;
    })
    .filter((agentId): agentId is string => {
      return agentId !== null;
    });

  return { statuses, sources, agents };
}

interface LogDetailParams {
  runId: string;
  userId: string;
  orgId: string;
}

interface RunResult {
  checkpointId?: string;
  agentSessionId?: string;
  conversationId?: string;
  artifact?: Record<string, string>;
  volumes?: Record<string, string>;
}

function extractArtifact(runResult: RunResult | null): {
  name: string | null;
  version: string | null;
} {
  if (!runResult?.artifact) {
    return { name: null, version: null };
  }

  const name = Object.keys(runResult.artifact)[0] ?? null;
  const version = name ? (runResult.artifact[name] ?? null) : null;
  return { name, version };
}

export function zeroLogDetail(
  params: LogDetailParams,
): Computed<Promise<LogDetail | null>> {
  return computed(async (get): Promise<LogDetail | null> => {
    const db = get(db$);

    const [result] = await db
      .select({
        run: agentRuns,
        composeVersion: agentComposeVersions,
        agentId: zeroAgents.id,
        agentDisplayName: zeroAgents.displayName,
        triggerSource: zeroRuns.triggerSource,
        automationId: zeroRuns.automationId,
        triggerAgentName: triggerAgentAlias.displayName,
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .leftJoin(
        agentComposes,
        eq(agentComposeVersions.composeId, agentComposes.id),
      )
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .leftJoin(
        triggerAgentAlias,
        eq(zeroRuns.triggerAgentId, triggerAgentAlias.id),
      )
      .where(
        and(
          eq(agentRuns.id, params.runId),
          eq(agentRuns.userId, params.userId),
          eq(agentRuns.orgId, params.orgId),
        ),
      )
      .limit(1);

    if (!result) {
      return null;
    }

    const {
      run,
      composeVersion,
      agentId,
      agentDisplayName,
      triggerSource,
      automationId,
      triggerAgentName,
      modelProvider,
      selectedModel,
    } = result;
    const runResult = run.result as RunResult | null;
    const agentSessionId = runResult?.agentSessionId ?? null;
    const composeContent = composeVersion?.content ?? null;

    return {
      id: run.id,
      sessionId: agentSessionId,
      agentId,
      displayName: agentDisplayName ?? null,
      framework: extractFramework(composeContent),
      modelProvider: modelProvider ?? null,
      selectedModel: selectedModel ?? null,
      triggerSource: normalizeTriggerSource(triggerSource ?? "cli"),
      triggerAgentName: triggerAgentName ?? null,
      automationId: automationId ?? null,
      status: run.status as LogStatus,
      prompt: run.prompt,
      appendSystemPrompt: run.appendSystemPrompt ?? null,
      error: run.error ?? null,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      artifact: extractArtifact(runResult),
    };
  });
}

interface LogSearchParams {
  userId: string;
  orgId: string;
  keyword: string;
  agentId?: string;
  runId?: string;
  since?: number;
  limit: number;
  before: number;
  after: number;
}

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseAxiomAgentEvent(value: unknown): AxiomAgentEvent | null {
  const event = asRecord(value);
  if (!event) {
    return null;
  }

  const time = event._time;
  const runId = event.runId;
  const userId = event.userId;
  const sequenceNumber = event.sequenceNumber;
  const eventType = event.eventType;
  if (
    typeof time !== "string" ||
    typeof runId !== "string" ||
    typeof userId !== "string" ||
    typeof eventType !== "string" ||
    typeof sequenceNumber !== "number" ||
    !Number.isSafeInteger(sequenceNumber) ||
    sequenceNumber < 0 ||
    sequenceNumber > MAX_EVENT_SEQUENCE_NUMBER
  ) {
    return null;
  }
  if (!Number.isFinite(Date.parse(time))) {
    return null;
  }

  return {
    _time: time,
    runId,
    userId,
    sequenceNumber,
    eventType,
    eventData: event.eventData,
  };
}

function parseAxiomAgentEvents(values: readonly unknown[]): AxiomAgentEvent[] {
  return values
    .map(parseAxiomAgentEvent)
    .filter((event): event is AxiomAgentEvent => {
      return event !== null;
    });
}

function toRunEvent(event: AxiomAgentEvent): RunEvent {
  return {
    sequenceNumber: event.sequenceNumber,
    eventType: event.eventType,
    eventData: event.eventData,
    createdAt: event._time,
  };
}

async function getUserRunIds(
  db: ServiceDb,
  userId: string,
  orgId: string,
  since: Date,
  agentId?: string,
): Promise<string[]> {
  const conditions = [
    eq(agentRuns.userId, userId),
    eq(agentRuns.orgId, orgId),
    gte(agentRuns.createdAt, since),
  ];

  if (agentId) {
    const rows = await db
      .select({ runId: agentRuns.id })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .leftJoin(
        agentComposes,
        eq(agentComposeVersions.composeId, agentComposes.id),
      )
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(and(...conditions, eq(zeroAgents.id, agentId)));

    return rows.map((r) => {
      return r.runId;
    });
  }

  const rows = await db
    .select({ runId: agentRuns.id })
    .from(agentRuns)
    .where(and(...conditions));

  return rows.map((r) => {
    return r.runId;
  });
}

function buildRunIdFilter(runIds: readonly string[]): string {
  return runIds.length === 1
    ? `| where runId == "${escapeAplString(runIds[0]!)}"`
    : `| where runId in (${runIds
        .map((id) => {
          return `"${escapeAplString(id)}"`;
        })
        .join(", ")})`;
}

function chunkRunIds(runIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < runIds.length;
    index += AXIOM_RUN_ID_FILTER_CHUNK_SIZE
  ) {
    chunks.push(runIds.slice(index, index + AXIOM_RUN_ID_FILTER_CHUNK_SIZE));
  }
  return chunks;
}

function buildSearchApl(params: {
  readonly dataset: string;
  readonly sinceISO: string;
  readonly runIds: readonly string[];
  readonly keyword: string;
  readonly limit: number;
}): string {
  const runIdFilter = buildRunIdFilter(params.runIds);
  return `['${params.dataset}']
| where _time > datetime("${params.sinceISO}")
${runIdFilter}
| search "*${escapeAplString(params.keyword)}*"
| order by _time desc
| limit ${params.limit}`;
}

function compareAxiomSearchEventsDesc(
  left: AxiomAgentEvent,
  right: AxiomAgentEvent,
): number {
  const timeDiff = Date.parse(right._time) - Date.parse(left._time);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  const runDiff = left.runId.localeCompare(right.runId);
  if (runDiff !== 0) {
    return runDiff;
  }

  return left.sequenceNumber - right.sequenceNumber;
}

function queryMatchingEvents(params: {
  readonly dataset: string;
  readonly sinceISO: string;
  readonly targetRunIds: readonly string[];
  readonly keyword: string;
  readonly limit: number;
}): Computed<Promise<AxiomAgentEvent[]>> {
  return computed(async (get): Promise<AxiomAgentEvent[]> => {
    const matchedEvents: AxiomAgentEvent[] = [];
    const runIdChunks = chunkRunIds(params.targetRunIds);
    for (
      let index = 0;
      index < runIdChunks.length;
      index += AXIOM_SEARCH_QUERY_CONCURRENCY
    ) {
      const batch = runIdChunks.slice(
        index,
        index + AXIOM_SEARCH_QUERY_CONCURRENCY,
      );
      const batchEvents = await Promise.all(
        batch.map(async (runIdChunk) => {
          const searchApl = buildSearchApl({
            dataset: params.dataset,
            sinceISO: params.sinceISO,
            runIds: runIdChunk,
            keyword: params.keyword,
            limit: params.limit + 1,
          });
          return parseAxiomAgentEvents(await get(queryAxiom(searchApl)));
        }),
      );

      for (const events of batchEvents) {
        matchedEvents.push(...events);
      }
    }

    return matchedEvents.sort(compareAxiomSearchEventsDesc);
  });
}

function getSearchContextMap(params: {
  readonly dataset: string;
  readonly matches: readonly AxiomAgentEvent[];
  readonly before: number;
  readonly after: number;
}): Computed<Promise<Map<string, AxiomAgentEvent>>> {
  return computed(async (get): Promise<Map<string, AxiomAgentEvent>> => {
    const contextMap = new Map<string, AxiomAgentEvent>();
    if (params.before === 0 && params.after === 0) {
      return contextMap;
    }

    const contextConditions = params.matches.map((match) => {
      const seqMin = Math.max(0, match.sequenceNumber - params.before);
      const seqMax = match.sequenceNumber + params.after;
      return `(runId == "${escapeAplString(match.runId)}" and sequenceNumber >= ${seqMin} and sequenceNumber <= ${seqMax})`;
    });

    const contextApl = `['${params.dataset}']
| where ${contextConditions.join("\n  or ")}
| order by runId asc, sequenceNumber asc`;

    const contextEvents = parseAxiomAgentEvents(
      await get(queryAxiom(contextApl)),
    );

    for (const event of contextEvents) {
      contextMap.set(`${event.runId}:${event.sequenceNumber}`, event);
    }

    return contextMap;
  });
}

function buildSearchResults(params: {
  readonly matches: readonly AxiomAgentEvent[];
  readonly before: number;
  readonly after: number;
  readonly contextMap: Map<string, AxiomAgentEvent>;
  readonly runMetadata: Map<
    string,
    { readonly agentName: string; readonly framework: string | null }
  >;
}): LogsSearchResponse["results"] {
  return params.matches.map((match) => {
    const contextBefore: RunEvent[] = [];
    const contextAfter: RunEvent[] = [];
    const metadata = params.runMetadata.get(match.runId);

    for (
      let i = match.sequenceNumber - params.before;
      i < match.sequenceNumber;
      i++
    ) {
      const event = params.contextMap.get(`${match.runId}:${i}`);
      if (event) {
        contextBefore.push(toRunEvent(event));
      }
    }

    for (
      let i = match.sequenceNumber + 1;
      i <= match.sequenceNumber + params.after;
      i++
    ) {
      const event = params.contextMap.get(`${match.runId}:${i}`);
      if (event) {
        contextAfter.push(toRunEvent(event));
      }
    }

    return {
      runId: match.runId,
      agentName: metadata?.agentName ?? "unknown",
      framework: metadata?.framework ?? null,
      matchedEvent: toRunEvent(match),
      contextBefore,
      contextAfter,
    };
  });
}

async function getSearchRunMetadata(
  db: ServiceDb,
  runIds: string[],
  userId: string,
  orgId: string,
): Promise<
  Map<string, { readonly agentName: string; readonly framework: string | null }>
> {
  const result = new Map<
    string,
    { readonly agentName: string; readonly framework: string | null }
  >();
  if (runIds.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      runId: agentRuns.id,
      composeId: agentComposes.id,
      composeContent: agentComposeVersions.content,
      displayName: zeroAgents.displayName,
    })
    .from(agentRuns)
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(
      and(
        inArray(agentRuns.id, runIds),
        eq(agentRuns.userId, userId),
        eq(agentRuns.orgId, orgId),
      ),
    );

  for (const row of rows) {
    result.set(row.runId, {
      agentName: row.displayName ?? row.composeId ?? "unknown",
      framework: extractFramework(row.composeContent),
    });
  }

  return result;
}

export function zeroLogSearch(
  params: LogSearchParams,
): Computed<Promise<LogsSearchResponse>> {
  return computed(async (get): Promise<LogsSearchResponse> => {
    const db = get(db$);
    const { keyword, runId, limit, before, after } = params;
    const since = params.since ?? now() - SEVEN_DAYS_MS;
    const sinceDate = new Date(since);
    const sinceISO = sinceDate.toISOString();
    const dataset = getDatasetName("agent-run-events");

    // Determine which run IDs to search (ownership verified via DB)
    let targetRunIds: string[];
    if (runId) {
      const [run] = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.userId, params.userId),
            eq(agentRuns.orgId, params.orgId),
          ),
        )
        .limit(1);

      if (!run) {
        return { results: [], hasMore: false };
      }
      targetRunIds = [runId];
    } else {
      targetRunIds = await getUserRunIds(
        db,
        params.userId,
        params.orgId,
        sinceDate,
        params.agentId,
      );
      if (targetRunIds.length === 0) {
        return { results: [], hasMore: false };
      }
    }

    const matchedEvents = await get(
      queryMatchingEvents({
        dataset,
        sinceISO,
        targetRunIds,
        keyword,
        limit,
      }),
    );
    if (matchedEvents.length === 0) {
      return { results: [], hasMore: false };
    }

    const hasMore = matchedEvents.length > limit;
    const matches = hasMore ? matchedEvents.slice(0, limit) : matchedEvents;

    const contextMap = await get(
      getSearchContextMap({
        dataset,
        matches,
        before,
        after,
      }),
    );
    const matchedRunIds = [
      ...new Set(
        matches.map((e) => {
          return e.runId;
        }),
      ),
    ];
    const runMetadata = await getSearchRunMetadata(
      db,
      matchedRunIds,
      params.userId,
      params.orgId,
    );

    const results = buildSearchResults({
      matches,
      before,
      after,
      contextMap,
      runMetadata,
    });
    return { results, hasMore };
  });
}
