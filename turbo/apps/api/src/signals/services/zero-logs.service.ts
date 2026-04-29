import { computed, type Computed } from "ccstate";
import type {
  LogDetail,
  LogEntry,
  LogStatus,
  LogsFilters,
  TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
import type {
  LogsSearchResponse,
  RunEvent,
} from "@vm0/api-contracts/contracts/runs";
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
  isNotNull,
  lt,
  or,
  type SQL,
} from "drizzle-orm";

import { db$, type Db } from "../external/db";
import { getDatasetName, queryAxiom } from "../external/axiom";
import { now } from "../../lib/time";

type ServiceDb = Pick<Db, "select" | "selectDistinct">;

const triggerAgentAlias = alias(zeroAgents, "trigger_agent");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface AgentComposeContent {
  agents: Record<string, { framework: string }>;
}

function extractFramework(composeContent: unknown): string | null {
  const content = composeContent as AgentComposeContent | null;
  const agentNames = content?.agents ? Object.keys(content.agents) : [];
  const firstAgent =
    agentNames.length > 0 ? content?.agents[agentNames[0]!] : null;
  return firstAgent?.framework ?? null;
}

function buildCursorCondition(cursor: string): SQL | null {
  const separatorIndex = cursor.lastIndexOf("|");
  if (separatorIndex <= 0) {
    return null;
  }

  const cursorTime = cursor.slice(0, separatorIndex);
  const cursorId = cursor.slice(separatorIndex + 1);
  const cursorDate = new Date(cursorTime);

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
  agent?: string;
  name?: string;
  since?: number;
  status?: LogStatus;
  triggerSource?: TriggerSource;
  scheduleId?: string;
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

    // Agent name filter: name takes precedence over agent, which takes precedence over search
    if (params.name) {
      conditions.push(eq(agentComposes.name, params.name));
    } else if (params.agent) {
      conditions.push(eq(agentComposes.name, params.agent));
    } else if (params.search) {
      conditions.push(ilike(agentComposes.name, `%${params.search}%`));
    }

    if (params.since) {
      conditions.push(gte(agentRuns.createdAt, new Date(params.since)));
    }
    if (params.status) {
      conditions.push(eq(agentRuns.status, params.status));
    }
    if (params.triggerSource) {
      conditions.push(eq(zeroRuns.triggerSource, params.triggerSource));
    }
    if (params.scheduleId) {
      conditions.push(eq(zeroRuns.scheduleId, params.scheduleId));
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
          scheduleId: zeroRuns.scheduleId,
          composeId: agentComposes.id,
          composeName: agentComposes.name,
          composeContent: agentComposeVersions.content,
          displayName: zeroAgents.displayName,
          triggerAgentName: triggerAgentAlias.displayName,
          sessionId: conversations.cliAgentSessionId,
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
          sessionId: run.sessionId ?? null,
          agentId: run.composeId ?? null,
          displayName: run.displayName ?? null,
          framework: extractFramework(run.composeContent),
          triggerSource: (run.triggerSource ?? "cli") as TriggerSource,
          triggerAgentName: run.triggerAgentName ?? null,
          scheduleId: run.scheduleId ?? null,
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

  if (params.name) {
    conditions.push(eq(agentComposes.name, params.name));
  } else if (params.agent) {
    conditions.push(eq(agentComposes.name, params.agent));
  } else if (params.search) {
    conditions.push(ilike(agentComposes.name, `%${params.search}%`));
  }

  if (params.since) {
    conditions.push(gte(agentRuns.createdAt, new Date(params.since)));
  }
  if (params.status) {
    conditions.push(eq(agentRuns.status, params.status));
  }
  if (params.triggerSource) {
    conditions.push(eq(zeroRuns.triggerSource, params.triggerSource));
  }
  if (params.scheduleId) {
    conditions.push(eq(zeroRuns.scheduleId, params.scheduleId));
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
      .selectDistinct({ name: agentComposes.name })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .leftJoin(
        agentComposes,
        eq(agentComposeVersions.composeId, agentComposes.id),
      )
      .where(and(...baseConditions, isNotNull(agentComposes.name))),
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
      return [
        "schedule",
        "web",
        "slack",
        "email",
        "telegram",
        "github",
        "cli",
        "agent",
        "voice-chat",
      ].includes(s as string);
    });

  const agents = agentRows
    .map((r) => {
      return r.name;
    })
    .filter((name): name is string => {
      return name !== null;
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
        compose: agentComposes,
        composeVersion: agentComposeVersions,
        agentDisplayName: zeroAgents.displayName,
        triggerSource: zeroRuns.triggerSource,
        scheduleId: zeroRuns.scheduleId,
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
      compose,
      composeVersion,
      agentDisplayName,
      triggerSource,
      scheduleId,
      triggerAgentName,
      modelProvider,
      selectedModel,
    } = result;
    const runResult = run.result as RunResult | null;
    const composeContent =
      composeVersion?.content as AgentComposeContent | null;

    return {
      id: run.id,
      sessionId: runResult?.agentSessionId ?? null,
      agentId: compose?.id ?? null,
      displayName: agentDisplayName ?? null,
      framework: extractFramework(composeContent),
      modelProvider: modelProvider ?? null,
      selectedModel: selectedModel ?? null,
      triggerSource: (triggerSource ?? "cli") as TriggerSource,
      triggerAgentName: triggerAgentName ?? null,
      scheduleId: scheduleId ?? null,
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

function escapeApl(value: string): string {
  return value.replace(/\\/g, String.raw`\\`).replace(/"/g, String.raw`\"`);
}

interface LogSearchParams {
  userId: string;
  orgId: string;
  keyword: string;
  agent?: string;
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
  agentName?: string,
): Promise<string[]> {
  const conditions = [
    eq(agentRuns.userId, userId),
    eq(agentRuns.orgId, orgId),
    gte(agentRuns.createdAt, since),
  ];

  if (agentName) {
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
      .where(and(...conditions, eq(agentComposes.name, agentName)));

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

function buildRunIdFilter(runIds: string[]): string {
  return runIds.length === 1
    ? `| where runId == "${escapeApl(runIds[0]!)}"`
    : `| where runId in (${runIds
        .map((id) => {
          return `"${escapeApl(id)}"`;
        })
        .join(", ")})`;
}

async function getAgentNames(
  db: ServiceDb,
  runIds: string[],
  userId: string,
  orgId: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (runIds.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      runId: agentRuns.id,
      composeName: agentComposes.name,
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
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.orgId, orgId)));

  for (const row of rows) {
    result.set(row.runId, row.composeName || "unknown");
  }

  return result;
}

export function zeroLogSearch(
  params: LogSearchParams,
): Computed<Promise<LogsSearchResponse>> {
  return computed(async (get): Promise<LogsSearchResponse> => {
    const db = get(db$);
    const { keyword, agent, runId, limit, before, after } = params;
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
        agent,
      );
      if (targetRunIds.length === 0) {
        return { results: [], hasMore: false };
      }
    }

    const runIdFilter = buildRunIdFilter(targetRunIds);

    // Search events in Axiom
    const searchApl = `['${dataset}']
| where _time > datetime("${sinceISO}")
${runIdFilter}
| search "*${escapeApl(keyword)}*"
| order by _time desc
| limit ${limit + 1}`;

    const matchedEvents = (
      await get(queryAxiom(searchApl))
    ).slice() as unknown as AxiomAgentEvent[];

    if (matchedEvents.length === 0) {
      return { results: [], hasMore: false };
    }

    const hasMore = matchedEvents.length > limit;
    const matches = hasMore ? matchedEvents.slice(0, limit) : matchedEvents;

    // Fetch context events
    const contextMap = new Map<string, AxiomAgentEvent>();
    if (before > 0 || after > 0) {
      const contextConditions = matches.map((match) => {
        const seqMin = Math.max(0, match.sequenceNumber - before);
        const seqMax = match.sequenceNumber + after;
        return `(runId == "${escapeApl(match.runId)}" and sequenceNumber >= ${seqMin} and sequenceNumber <= ${seqMax})`;
      });

      const contextApl = `['${dataset}']
| where ${contextConditions.join("\n  or ")}
| order by runId asc, sequenceNumber asc`;

      const contextEvents = (
        await get(queryAxiom(contextApl))
      ).slice() as unknown as AxiomAgentEvent[];

      for (const event of contextEvents) {
        contextMap.set(`${event.runId}:${event.sequenceNumber}`, event);
      }
    }

    // Resolve agent names
    const matchedRunIds = [
      ...new Set(
        matches.map((e) => {
          return e.runId;
        }),
      ),
    ];
    const agentNames = await getAgentNames(
      db,
      matchedRunIds,
      params.userId,
      params.orgId,
    );

    // Assemble results
    const results = matches.map((match) => {
      const contextBefore: RunEvent[] = [];
      const contextAfter: RunEvent[] = [];

      for (
        let i = match.sequenceNumber - before;
        i < match.sequenceNumber;
        i++
      ) {
        const event = contextMap.get(`${match.runId}:${i}`);
        if (event) {
          contextBefore.push(toRunEvent(event));
        }
      }

      for (
        let i = match.sequenceNumber + 1;
        i <= match.sequenceNumber + after;
        i++
      ) {
        const event = contextMap.get(`${match.runId}:${i}`);
        if (event) {
          contextAfter.push(toRunEvent(event));
        }
      }

      return {
        runId: match.runId,
        agentName: agentNames.get(match.runId) || "unknown",
        matchedEvent: toRunEvent(match),
        contextBefore,
        contextAfter,
      };
    });

    return { results, hasMore };
  });
}
