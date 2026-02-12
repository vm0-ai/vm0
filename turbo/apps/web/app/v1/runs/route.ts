/**
 * Public API v1 - Runs Endpoints
 *
 * GET /v1/runs - List runs
 * POST /v1/runs - Create run
 */
import { initServices } from "../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../src/lib/public-api/handler";
import { publicRunsListContract, type PublicApiErrorType } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../src/lib/public-api/auth";
import { getUserScopeByClerkId } from "../../../src/lib/scope/scope-service";
import { agentRuns } from "../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../src/db/schema/agent-compose";
import { eq, and, desc, gt } from "drizzle-orm";
import {
  validateCheckpoint,
  validateAgentSession,
  createRun,
} from "../../../src/lib/run";
import {
  isConcurrentRunLimit,
  isForbidden,
  isBadRequest,
  isNotFound,
} from "../../../src/lib/errors";

interface ResolvedAgent {
  agentComposeVersionId: string;
  agentCompose?: typeof agentComposes.$inferSelect;
}

type PublicApiError400 = {
  status: 400;
  body: { error: { type: PublicApiErrorType; code: string; message: string } };
};

type PublicApiError404 = {
  status: 404;
  body: { error: { type: PublicApiErrorType; code: string; message: string } };
};

type PublicApiErrorResponse = PublicApiError400 | PublicApiError404;

/**
 * Resolve agent compose from request body parameters.
 * Priority: checkpointId > sessionId > agentId > agent (name)
 */
async function resolveAgent(
  body: {
    checkpointId?: string;
    sessionId?: string;
    agentId?: string;
    agent?: string;
  },
  userId: string,
  scopeId: string,
): Promise<ResolvedAgent | PublicApiErrorResponse> {
  if (body.checkpointId) {
    const checkpointData = await validateCheckpoint(body.checkpointId, userId);
    return { agentComposeVersionId: checkpointData.agentComposeVersionId };
  }

  if (body.sessionId) {
    return resolveFromSession(body.sessionId, userId);
  }

  if (body.agentId) {
    return resolveFromAgentId(body.agentId, scopeId);
  }

  if (body.agent) {
    return resolveFromAgentName(body.agent, scopeId);
  }

  return {
    status: 400 as const,
    body: {
      error: {
        type: "invalid_request_error" as const,
        code: "missing_parameter",
        message:
          "Must provide one of: agent, agentId, sessionId, or checkpointId",
      },
    },
  };
}

async function resolveFromSession(
  sessionId: string,
  userId: string,
): Promise<ResolvedAgent | PublicApiErrorResponse> {
  const sessionData = await validateAgentSession(sessionId, userId);

  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, sessionData.agentComposeId))
    .limit(1);

  if (!compose?.headVersionId) {
    return {
      status: 404 as const,
      body: {
        error: {
          type: "not_found_error" as const,
          code: "resource_not_found",
          message: "Agent for session not found or has no versions",
        },
      },
    };
  }

  return {
    agentComposeVersionId: compose.headVersionId,
    agentCompose: compose,
  };
}

async function resolveFromAgentId(
  agentId: string,
  scopeId: string,
): Promise<ResolvedAgent | PublicApiErrorResponse> {
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(
      and(eq(agentComposes.id, agentId), eq(agentComposes.scopeId, scopeId)),
    )
    .limit(1);

  if (!compose) {
    return {
      status: 404 as const,
      body: {
        error: {
          type: "not_found_error" as const,
          code: "resource_not_found",
          message: `No such agent: '${agentId}'`,
        },
      },
    };
  }

  if (!compose.headVersionId) {
    return {
      status: 400 as const,
      body: {
        error: {
          type: "invalid_request_error" as const,
          code: "invalid_parameter",
          message: "Agent has no versions. Create a version first.",
        },
      },
    };
  }

  return {
    agentComposeVersionId: compose.headVersionId,
    agentCompose: compose,
  };
}

async function resolveFromAgentName(
  agentName: string,
  scopeId: string,
): Promise<ResolvedAgent | PublicApiErrorResponse> {
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.name, agentName),
        eq(agentComposes.scopeId, scopeId),
      ),
    )
    .limit(1);

  if (!compose) {
    return {
      status: 404 as const,
      body: {
        error: {
          type: "not_found_error" as const,
          code: "resource_not_found",
          message: `No such agent: '${agentName}'`,
        },
      },
    };
  }

  if (!compose.headVersionId) {
    return {
      status: 400 as const,
      body: {
        error: {
          type: "invalid_request_error" as const,
          code: "invalid_parameter",
          message: "Agent has no versions. Create a version first.",
        },
      },
    };
  }

  return {
    agentComposeVersionId: compose.headVersionId,
    agentCompose: compose,
  };
}

function isErrorResponse(
  result: ResolvedAgent | PublicApiErrorResponse,
): result is PublicApiErrorResponse {
  return "status" in result;
}

/**
 * Translate createRun() errors into Public API error format
 */
function handlePublicApiError(error: unknown) {
  if (isConcurrentRunLimit(error)) {
    return {
      status: 429 as const,
      body: {
        error: {
          type: "rate_limit_error" as const,
          code: "concurrent_run_limit_exceeded",
          message: error.message,
        },
      },
    };
  }
  if (isForbidden(error)) {
    return {
      status: 401 as const,
      body: {
        error: {
          type: "authentication_error" as const,
          code: "permission_denied",
          message: error.message,
        },
      },
    };
  }
  if (isBadRequest(error)) {
    return {
      status: 400 as const,
      body: {
        error: {
          type: "invalid_request_error" as const,
          code: "invalid_parameter",
          message: error.message,
        },
      },
    };
  }
  if (isNotFound(error)) {
    return {
      status: 404 as const,
      body: {
        error: {
          type: "not_found_error" as const,
          code: "resource_not_found",
          message: error.message,
        },
      },
    };
  }
  return null;
}

const router = tsr.router(publicRunsListContract, {
  list: async ({ query, headers }) => {
    initServices();

    const auth = await authenticatePublicApi(headers.authorization);
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Get user's scope
    const userScope = await getUserScopeByClerkId(auth.userId);
    if (!userScope) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message:
              "Please set up your scope first. Login again with: vm0 login",
          },
        },
      };
    }

    // Build query conditions - filter by user
    const conditions = [eq(agentRuns.userId, auth.userId)];

    // Handle cursor-based pagination
    if (query.cursor) {
      conditions.push(gt(agentRuns.id, query.cursor));
    }

    // Filter by status if provided
    if (query.status) {
      conditions.push(eq(agentRuns.status, query.status));
    }

    const limit = query.limit ?? 20;

    // Fetch runs with agent info
    const runs = await globalThis.services.db
      .select({
        run: agentRuns,
        compose: agentComposes,
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
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit + 1);

    // Determine pagination info
    const hasMore = runs.length > limit;
    const data = hasMore ? runs.slice(0, limit) : runs;
    const nextCursor =
      hasMore && data.length > 0 ? data[data.length - 1]!.run.id : null;

    return {
      status: 200 as const,
      body: {
        data: data.map(({ run, compose }) => ({
          id: run.id,
          agentId: compose?.id ?? "",
          agentName: compose?.name ?? "unknown",
          status: run.status as
            | "pending"
            | "running"
            | "completed"
            | "failed"
            | "timeout"
            | "cancelled",
          prompt: run.prompt,
          createdAt: run.createdAt.toISOString(),
          startedAt: run.startedAt?.toISOString() ?? null,
          completedAt: run.completedAt?.toISOString() ?? null,
        })),
        pagination: {
          hasMore: hasMore,
          nextCursor: nextCursor,
        },
      },
    };
  },

  create: async ({ body, headers }) => {
    const apiStartTime = Date.now();
    initServices();

    const auth = await authenticatePublicApi(headers.authorization);
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Get user's scope
    const userScope = await getUserScopeByClerkId(auth.userId);
    if (!userScope) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message:
              "Please set up your scope first. Login again with: vm0 login",
          },
        },
      };
    }

    // Resolve the agent to run
    const resolved = await resolveAgent(body, auth.userId, userScope.id);
    if (isErrorResponse(resolved)) {
      // Narrow the discriminated union for ts-rest type compatibility
      if (resolved.status === 404) return resolved;
      return resolved;
    }

    // Delegate run creation, validation, and dispatch to createRun()
    try {
      const result = await createRun({
        userId: auth.userId,
        agentComposeVersionId: resolved.agentComposeVersionId,
        prompt: body.prompt,
        composeId: resolved.agentCompose?.id,
        checkpointId: body.checkpointId,
        sessionId: body.sessionId,
        vars: body.variables,
        secrets: body.secrets,
        volumeVersions: body.volumes,
        resumedFromCheckpointId: body.checkpointId,
        agentName: resolved.agentCompose?.name,
        apiStartTime,
      });

      return {
        status: 202 as const,
        body: {
          id: result.runId,
          agentId: resolved.agentCompose?.id ?? "",
          agentName: resolved.agentCompose?.name ?? "unknown",
          status: result.status as
            | "pending"
            | "running"
            | "completed"
            | "failed"
            | "timeout"
            | "cancelled",
          prompt: body.prompt,
          createdAt: result.createdAt.toISOString(),
          startedAt: null,
          completedAt: null,
          error: null,
          executionTimeMs: null,
          checkpointId: null,
          sessionId: body.sessionId ?? null,
          artifactName: body.artifactName ?? null,
          artifactVersion: body.artifactVersion ?? null,
          volumes: body.volumes,
        },
      };
    } catch (error) {
      const errorResponse = handlePublicApiError(error);
      if (errorResponse) {
        return errorResponse;
      }
      throw error;
    }
  },
});

const handler = createPublicApiHandler(publicRunsListContract, router);

export { handler as GET, handler as POST };
