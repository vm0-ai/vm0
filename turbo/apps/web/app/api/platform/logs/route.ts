/**
 * Platform API - Logs List Endpoint
 *
 * GET /api/platform/logs - List agent run logs with pagination and search
 */
import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { platformLogsListContract, type PlatformLogStatus } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { conversations } from "../../../../src/db/schema/conversation";
import {
  getOrgData,
  getOrgBySlug,
} from "../../../../src/lib/org/org-cache-service";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../src/lib/logger";
import { eq, and, desc, lt, or, ilike, count, type SQL } from "drizzle-orm";

const log = logger("api:platform:logs");

// Minimal type for extracting framework from compose content
interface AgentComposeContent {
  agents: Record<string, { framework: string }>;
}

interface LogsQuery {
  name?: string;
  agent?: string;
  search?: string;
  status?: PlatformLogStatus;
  cursor?: string;
  limit?: number;
}

/**
 * Build agent name/org filter conditions from query params.
 * name takes precedence over legacy agent param, which takes precedence over search.
 */
function buildAgentFilterConditions(
  query: LogsQuery,
  orgId: string | null,
): SQL[] {
  const conditions: SQL[] = [];

  if (query.name) {
    conditions.push(eq(agentComposes.name, query.name));
    if (orgId) {
      conditions.push(eq(agentComposes.orgId, orgId));
    }
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
  orgId: string | null,
): Promise<number> {
  const conditions: SQL[] = [eq(agentRuns.userId, userId)];
  conditions.push(...buildAgentFilterConditions(query, orgId));
  if (query.status) {
    conditions.push(eq(agentRuns.status, query.status));
  }

  const needsComposeJoin = !!(query.name || query.agent || query.search);

  let countQuery;
  if (needsComposeJoin) {
    countQuery = globalThis.services.db
      .select({ count: count() })
      .from(agentRuns)
      .leftJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .leftJoin(
        agentComposes,
        eq(agentComposeVersions.composeId, agentComposes.id),
      )
      .where(and(...conditions));
  } else {
    countQuery = globalThis.services.db
      .select({ count: count() })
      .from(agentRuns)
      .where(and(...conditions));
  }

  const [result] = await countQuery;
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

const router = tsr.router(platformLogsListContract, {
  list: async ({ query }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const limit = query.limit ?? 20;

    // Resolve org slug to orgId for filtering
    let orgId: string | null = null;
    if (query.org) {
      const orgData = await getOrgBySlug(query.org);
      orgId = orgData?.orgId ?? null;
      if (!orgId) {
        return {
          status: 200 as const,
          body: {
            data: [],
            pagination: { hasMore: false, nextCursor: null, totalPages: 0 },
          },
        };
      }
    }

    // Build conditions
    const conditions: SQL[] = [eq(agentRuns.userId, userId)];

    if (query.cursor) {
      const cursorCondition = buildCursorCondition(query.cursor);
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    conditions.push(...buildAgentFilterConditions(query, orgId));

    if (query.status) {
      conditions.push(eq(agentRuns.status, query.status));
    }

    const runs = await globalThis.services.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        composeName: agentComposes.name,
        orgId: agentComposes.orgId,
        sessionId: conversations.cliAgentSessionId,
        composeContent: agentComposeVersions.content,
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
      .leftJoin(conversations, eq(agentRuns.id, conversations.runId))
      .where(and(...conditions))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(limit + 1);

    // Resolve org slugs via org cache (skip orgs that fail lookup)
    const uniqueOrgIds = [
      ...new Set(runs.filter((r) => r.orgId).map((r) => r.orgId!)),
    ];
    const slugMap = new Map<string, string>();
    await Promise.all(
      uniqueOrgIds.map(async (id) => {
        try {
          const data = await getOrgData(id);
          slugMap.set(id, data.slug);
        } catch (err) {
          log.warn("failed to resolve org slug for run", {
            orgId: id,
            error: err,
          });
        }
      }),
    );

    const totalCount = await getTotalCount(userId, query, orgId);
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
        data: data.map((run) => ({
          id: run.id,
          sessionId: run.sessionId ?? null,
          agentName: run.composeName ?? "unknown",
          orgSlug: run.orgId ? (slugMap.get(run.orgId) ?? null) : null,
          framework: extractFramework(run.composeContent),
          status: run.status as PlatformLogStatus,
          createdAt: run.createdAt.toISOString(),
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
        })),
        pagination: {
          hasMore,
          nextCursor,
          totalPages,
        },
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

const handler = createHandler(platformLogsListContract, router, {
  errorHandler,
});

export { handler as GET };
