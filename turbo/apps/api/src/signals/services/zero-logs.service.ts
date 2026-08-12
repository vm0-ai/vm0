import { computed, type Computed } from "ccstate";
import {
  triggerSourceSchema,
  type LogDetail,
  type LogEntry,
  type LogStatus,
  type LogsFilters,
  type TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
import { isSupportedFramework } from "@vm0/core/frameworks";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { conversations } from "@vm0/db/schema/conversation";
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

type ServiceDb = Pick<Db, "select" | "selectDistinct">;

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

    if (params.since !== undefined) {
      conditions.push(gte(agentRuns.createdAt, new Date(params.since)));
    }
    if (params.status) {
      conditions.push(eq(agentRuns.status, params.status));
    }
    if (params.triggerSource) {
      conditions.push(eq(zeroRuns.triggerSource, params.triggerSource));
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
          agentId: zeroAgents.id,
          composeName: agentComposes.name,
          composeContent: agentComposeVersions.content,
          displayName: zeroAgents.displayName,
          cliAgentSessionId: conversations.cliAgentSessionId,
        })
        .from(agentRuns)
        .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
        .leftJoin(
          agentComposeVersions,
          eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
        )
        .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
        .leftJoin(
          agentComposes,
          eq(agentSessions.agentComposeId, agentComposes.id),
        )
        .leftJoin(zeroAgents, eq(agentSessions.agentComposeId, zeroAgents.id))
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
          triggerSource: normalizeTriggerSource(run.triggerSource),
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

  if (params.since !== undefined) {
    conditions.push(gte(agentRuns.createdAt, new Date(params.since)));
  }
  if (params.status) {
    conditions.push(eq(agentRuns.status, params.status));
  }
  if (params.triggerSource) {
    conditions.push(eq(zeroRuns.triggerSource, params.triggerSource));
  }

  const [result] = await db
    .select({ count: count() })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
    .leftJoin(agentComposes, eq(agentSessions.agentComposeId, agentComposes.id))
    .leftJoin(zeroAgents, eq(agentSessions.agentComposeId, zeroAgents.id))
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
      .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
      .leftJoin(zeroAgents, eq(agentSessions.agentComposeId, zeroAgents.id))
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
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(agentRuns)
      .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .leftJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
      .leftJoin(zeroAgents, eq(agentSessions.agentComposeId, zeroAgents.id))
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
      modelProvider,
      selectedModel,
    } = result;
    const runResult = run.result as RunResult | null;
    const agentSessionId = runResult?.agentSessionId ?? null;
    const composeContent = composeVersion?.content ?? null;
    const framework = extractFramework(composeContent);

    return {
      id: run.id,
      sessionId: agentSessionId,
      agentId,
      displayName: agentDisplayName ?? null,
      framework,
      modelProvider: modelProvider ?? null,
      selectedModel: selectedModel ?? null,
      triggerSource: normalizeTriggerSource(triggerSource),
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
