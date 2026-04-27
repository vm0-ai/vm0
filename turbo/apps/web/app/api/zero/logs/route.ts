/**
 * Zero API - Logs List Endpoint
 *
 * GET /api/zero/logs - List agent run logs with pagination and search
 */
import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import {
  logsListContract,
  logStatusSchema,
  triggerSourceSchema,
  type LogStatus,
  type TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { alias } from "drizzle-orm/pg-core";
import { conversations } from "@vm0/db/schema/conversation";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { isNotFound, isForbidden } from "@vm0/api-services/errors";
import {
  eq,
  and,
  desc,
  lt,
  gte,
  or,
  ilike,
  count,
  isNotNull,
  type SQL,
} from "drizzle-orm";

/** Alias for the zero_agents table to resolve the triggering agent's display name. */
const triggerAgentAlias = alias(zeroAgents, "trigger_agent");

// Minimal type for extracting framework from compose content
interface AgentComposeContent {
  agents: Record<string, { framework: string }>;
}

interface LogsQuery {
  name?: string;
  org?: string;
  agent?: string;
  search?: string;
  since?: number;
  status?: LogStatus;
  triggerSource?: TriggerSource;
  scheduleId?: string;
  cursor?: string;
  limit?: number;
}

/**
 * Build agent name filter conditions from query params.
 * name takes precedence over legacy agent param, which takes precedence over search.
 */
function buildAgentFilterConditions(query: LogsQuery): SQL[] {
  const conditions: SQL[] = [];

  if (query.name) {
    conditions.push(eq(agentComposes.name, query.name));
  } else if (query.agent) {
    conditions.push(eq(agentComposes.name, query.agent));
  } else if (query.search) {
    conditions.push(ilike(agentComposes.name, `%${query.search}%`));
  }

  return conditions;
}

/**
 * Build cursor pagination condition from cursor string.
 * Cursor format: "createdAt|id" (ISO timestamp|uuid)
 */
function buildCursorCondition(cursor: string): SQL | null {
  const separatorIndex = cursor.lastIndexOf("|");
  if (separatorIndex <= 0) return null;

  const cursorTime = cursor.slice(0, separatorIndex);
  const cursorId = cursor.slice(separatorIndex + 1);
  const cursorDate = new Date(cursorTime);

  return or(
    lt(agentRuns.createdAt, cursorDate),
    and(eq(agentRuns.createdAt, cursorDate), lt(agentRuns.id, cursorId)),
  )!;
}

/**
 * Get total count of matching runs for pagination.
 */
async function getTotalCount(
  userId: string,
  query: LogsQuery,
  orgId: string,
): Promise<number> {
  const conditions: SQL[] = [
    eq(agentRuns.userId, userId),
    eq(agentRuns.orgId, orgId),
  ];
  conditions.push(...buildAgentFilterConditions(query));
  if (query.since) {
    conditions.push(gte(agentRuns.createdAt, new Date(query.since)));
  }
  if (query.status) {
    conditions.push(eq(agentRuns.status, query.status));
  }
  if (query.triggerSource) {
    conditions.push(eq(zeroRuns.triggerSource, query.triggerSource));
  }
  if (query.scheduleId) {
    conditions.push(eq(zeroRuns.scheduleId, query.scheduleId));
  }

  const [result] = await globalThis.services.db
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

/**
 * Extract framework string from compose content.
 */
function extractFramework(composeContent: unknown): string | null {
  const content = composeContent as AgentComposeContent | null;
  const agentNames = content?.agents ? Object.keys(content.agents) : [];
  const firstAgent =
    agentNames.length > 0 ? content?.agents[agentNames[0]!] : null;
  return firstAgent?.framework ?? null;
}

/**
 * Get distinct statuses, trigger sources, and agent names for filter dropdowns.
 */
async function getAvailableFilters(
  userId: string,
  orgId: string,
): Promise<{
  statuses: LogStatus[];
  sources: TriggerSource[];
  agents: string[];
}> {
  const db = globalThis.services.db;
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
      return logStatusSchema.safeParse(r.status);
    })
    .filter((r) => {
      return r.success;
    })
    .map((r) => {
      return r.data;
    });

  const sources = sourceRows
    .map((r) => {
      return triggerSourceSchema.safeParse(r.triggerSource);
    })
    .filter((r) => {
      return r.success;
    })
    .map((r) => {
      return r.data;
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

const router = tsr.router(logsListContract, {
  list: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const limit = query.limit ?? 20;

    // Resolve active org — always scope logs to the user's current org
    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    } catch (error) {
      if (isNotFound(error) || isForbidden(error)) {
        return {
          status: 200 as const,
          body: {
            data: [],
            pagination: { hasMore: false, nextCursor: null, totalPages: 0 },
            filters: { statuses: [], sources: [], agents: [] },
          },
        };
      }
      throw error;
    }

    // Build conditions — always filter by userId + orgId (using agentRuns.orgId
    // so that runs whose compose version was deleted are still visible)
    const conditions: SQL[] = [
      eq(agentRuns.userId, userId),
      eq(agentRuns.orgId, orgId),
    ];

    if (query.cursor) {
      const cursorCondition = buildCursorCondition(query.cursor);
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    conditions.push(...buildAgentFilterConditions(query));

    if (query.since) {
      conditions.push(gte(agentRuns.createdAt, new Date(query.since)));
    }
    if (query.status) {
      conditions.push(eq(agentRuns.status, query.status));
    }
    if (query.triggerSource) {
      conditions.push(eq(zeroRuns.triggerSource, query.triggerSource));
    }
    if (query.scheduleId) {
      conditions.push(eq(zeroRuns.scheduleId, query.scheduleId));
    }

    const runs = await globalThis.services.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        prompt: agentRuns.prompt,
        modelProvider: zeroRuns.modelProvider,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        triggerSource: zeroRuns.triggerSource,
        scheduleId: zeroRuns.scheduleId,
        composeId: agentComposes.id,
        composeName: agentComposes.name,
        orgId: agentComposes.orgId,
        sessionId: conversations.cliAgentSessionId,
        composeContent: agentComposeVersions.content,
        displayName: zeroAgents.displayName,
        triggerAgentName: triggerAgentAlias.displayName,
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
      .where(and(...conditions))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(limit + 1);

    const [totalCount, filters] = await Promise.all([
      getTotalCount(userId, query, orgId),
      getAvailableFilters(userId, orgId),
    ]);
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));

    // Determine pagination info
    const hasMore = runs.length > limit;
    const data = hasMore ? runs.slice(0, limit) : runs;

    // Build next cursor from last item
    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1]!;
      nextCursor = `${lastItem.createdAt.toISOString()}|${lastItem.id}`;
    }

    return {
      status: 200 as const,
      body: {
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
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "queryError" in err) {
    const validationError = err as {
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(logsListContract, router, {
  routeName: "zero.logs",
  errorHandler,
});

export { handler as GET };
