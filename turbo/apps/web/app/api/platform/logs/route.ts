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
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { eq, and, desc, lt, or, ilike, count } from "drizzle-orm";

// Minimal type for extracting framework from compose content
interface AgentComposeContent {
  agents: Record<string, { framework: string }>;
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

    // Build base conditions - filter by user
    const conditions = [eq(agentRuns.userId, userId)];

    // Handle cursor-based pagination
    // Cursor format: "createdAt|id" (ISO timestamp|uuid)
    if (query.cursor) {
      const separatorIndex = query.cursor.lastIndexOf("|");
      if (separatorIndex > 0) {
        const cursorTime = query.cursor.slice(0, separatorIndex);
        const cursorId = query.cursor.slice(separatorIndex + 1);
        const cursorDate = new Date(cursorTime);
        // Get records older than cursor, or same time but smaller id
        conditions.push(
          or(
            lt(agentRuns.createdAt, cursorDate),
            and(
              eq(agentRuns.createdAt, cursorDate),
              lt(agentRuns.id, cursorId),
            ),
          )!,
        );
      }
    }

    // Agent name filter: exact match takes precedence over fuzzy search
    if (query.agent) {
      conditions.push(eq(agentComposes.name, query.agent));
    } else if (query.search) {
      conditions.push(ilike(agentComposes.name, `%${query.search}%`));
    }

    const runs = await globalThis.services.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        createdAt: agentRuns.createdAt,
        composeName: agentComposes.name,
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

    // Get total count for pagination
    const countConditions = [eq(agentRuns.userId, userId)];
    if (query.agent) {
      countConditions.push(eq(agentComposes.name, query.agent));
    } else if (query.search) {
      countConditions.push(ilike(agentComposes.name, `%${query.search}%`));
    }

    let countQuery = globalThis.services.db
      .select({ count: count() })
      .from(agentRuns)
      .where(and(...countConditions));

    if (query.agent || query.search) {
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
        .where(and(...countConditions));
    }

    const [countResult] = await countQuery;
    const totalCount = countResult?.count ?? 0;
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
          // Extract framework from compose content (first agent definition)
          const content = run.composeContent as AgentComposeContent | null;
          const agentNames = content?.agents ? Object.keys(content.agents) : [];
          const firstAgent =
            agentNames.length > 0 ? content?.agents[agentNames[0]!] : null;
          const framework = firstAgent?.framework ?? null;

          return {
            id: run.id,
            sessionId: run.sessionId ?? null,
            agentName: run.composeName ?? "unknown",
            framework,
            status: run.status as PlatformLogStatus,
            createdAt: run.createdAt.toISOString(),
          };
        }),
        pagination: {
          hasMore: hasMore,
          nextCursor: nextCursor,
          totalPages: totalPages,
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
