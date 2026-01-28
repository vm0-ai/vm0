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
import { platformLogsListContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { eq, and, desc, lt, or, ilike, count } from "drizzle-orm";

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

    // Build the query with joins
    let queryBuilder = globalThis.services.db
      .select({
        id: agentRuns.id,
        createdAt: agentRuns.createdAt,
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
      .where(and(...conditions))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(limit + 1);

    // Apply search filter if provided (fuzzy match on agent name)
    if (query.search) {
      queryBuilder = globalThis.services.db
        .select({
          id: agentRuns.id,
          createdAt: agentRuns.createdAt,
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
        .where(
          and(...conditions, ilike(agentComposes.name, `%${query.search}%`)),
        )
        .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
        .limit(limit + 1);
    }

    const runs = await queryBuilder;

    // Get total count for pagination
    let countQuery = globalThis.services.db
      .select({ count: count() })
      .from(agentRuns)
      .where(eq(agentRuns.userId, userId));

    if (query.search) {
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
        .where(
          and(
            eq(agentRuns.userId, userId),
            ilike(agentComposes.name, `%${query.search}%`),
          ),
        );
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
        data: data.map((run) => ({
          id: run.id,
        })),
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
