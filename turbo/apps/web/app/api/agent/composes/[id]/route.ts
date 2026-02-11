import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { composesByIdContract } from "@vm0/core";
import { and, eq, inArray } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../../src/lib/auth/get-user-email";
import { canAccessCompose } from "../../../../../src/lib/agent/permission-service";
import type { AgentComposeYaml } from "../../../../../src/types/agent-compose";

const router = tsr.router(composesByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // JOIN compose + version in a single query
    const [result] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        userId: agentComposes.userId,
        scopeId: agentComposes.scopeId,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        createdAt: agentComposes.createdAt,
        updatedAt: agentComposes.updatedAt,
        content: agentComposeVersions.content,
      })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposes.headVersionId, agentComposeVersions.id),
      )
      .where(eq(agentComposes.id, params.id))
      .limit(1);

    if (!result) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

    // Check permission to access this compose
    const userEmail = await getUserEmail(userId);
    const hasAccess = await canAccessCompose(userId, userEmail, result);
    if (!hasAccess) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        id: result.id,
        name: result.name,
        headVersionId: result.headVersionId,
        content: (result.content as AgentComposeYaml) ?? null,
        createdAt: result.createdAt.toISOString(),
        updatedAt: result.updatedAt.toISOString(),
      },
    };
  },

  delete: async ({ params, headers }) => {
    initServices();

    // 1. Authenticate
    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // 2. Verify ownership (only owner can delete)
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(
        and(eq(agentComposes.id, params.id), eq(agentComposes.userId, userId)),
      )
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        },
      };
    }

    // 3. Check for running/pending runs
    const runningRuns = await globalThis.services.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .where(
        and(
          eq(agentComposeVersions.composeId, params.id),
          inArray(agentRuns.status, ["pending", "running"]),
        ),
      )
      .limit(1);

    if (runningRuns.length > 0) {
      return {
        status: 409 as const,
        body: {
          error: {
            message: "Cannot delete agent: agent is currently running",
            code: "CONFLICT",
          },
        },
      };
    }

    // 4. Delete agent (cascades handle related data)
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, params.id));

    return { status: 204 as const, body: undefined };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          { error: { message: issue.message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(composesByIdContract, router, {
  errorHandler,
});

export { handler as GET, handler as DELETE };
