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
import { publicRunsListContract } from "@vm0/core";
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
import { runService } from "../../../src/lib/run";
import { generateSandboxToken } from "../../../src/lib/auth/sandbox-token";

const router = tsr.router(publicRunsListContract, {
  list: async ({ query }) => {
    initServices();

    const auth = await authenticatePublicApi();
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
        status: 403 as const,
        body: {
          error: {
            type: "authorization_error" as const,
            code: "scope_not_configured",
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
          agent_id: compose?.id ?? "",
          agent_name: compose?.name ?? "unknown",
          status: run.status as
            | "pending"
            | "running"
            | "completed"
            | "failed"
            | "timeout"
            | "cancelled",
          prompt: run.prompt,
          created_at: run.createdAt.toISOString(),
          started_at: run.startedAt?.toISOString() ?? null,
          completed_at: run.completedAt?.toISOString() ?? null,
        })),
        pagination: {
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      },
    };
  },

  // eslint-disable-next-line complexity -- TODO: refactor complex function
  create: async ({ body }) => {
    initServices();

    const auth = await authenticatePublicApi();
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
        status: 403 as const,
        body: {
          error: {
            type: "authorization_error" as const,
            code: "scope_not_configured",
            message:
              "Please set up your scope first. Login again with: vm0 login",
          },
        },
      };
    }

    // Determine the agent to run
    let agentComposeVersionId: string | undefined;
    let agentCompose: typeof agentComposes.$inferSelect | undefined;

    // Priority: checkpoint_id > session_id > agent_id > agent (name)
    if (body.checkpoint_id) {
      // Resume from checkpoint - validate and get version ID
      const checkpointData = await runService.validateCheckpoint(
        body.checkpoint_id,
        auth.userId,
      );
      agentComposeVersionId = checkpointData.agentComposeVersionId;
    } else if (body.session_id) {
      // Continue session
      const sessionData = await runService.validateAgentSession(
        body.session_id,
        auth.userId,
      );

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

      agentComposeVersionId =
        sessionData.agentComposeVersionId || compose.headVersionId;
      agentCompose = compose;
    } else if (body.agent_id) {
      // Find by agent ID
      const [compose] = await globalThis.services.db
        .select()
        .from(agentComposes)
        .where(
          and(
            eq(agentComposes.id, body.agent_id),
            eq(agentComposes.scopeId, userScope.id),
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
              message: `No such agent: '${body.agent_id}'`,
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

      agentComposeVersionId = compose.headVersionId;
      agentCompose = compose;
    } else if (body.agent) {
      // Find by agent name
      const [compose] = await globalThis.services.db
        .select()
        .from(agentComposes)
        .where(
          and(
            eq(agentComposes.name, body.agent),
            eq(agentComposes.scopeId, userScope.id),
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
              message: `No such agent: '${body.agent}'`,
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

      agentComposeVersionId = compose.headVersionId;
      agentCompose = compose;
    } else {
      return {
        status: 400 as const,
        body: {
          error: {
            type: "invalid_request_error" as const,
            code: "missing_parameter",
            message:
              "Must provide one of: agent, agent_id, session_id, or checkpoint_id",
          },
        },
      };
    }

    // Create run record
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId: auth.userId,
        agentComposeVersionId: agentComposeVersionId!,
        status: "pending",
        prompt: body.prompt,
        vars: body.variables ?? null,
        secretNames: body.secrets ? Object.keys(body.secrets) : null,
        resumedFromCheckpointId: body.checkpoint_id ?? null,
      })
      .returning();

    if (!run) {
      return {
        status: 500 as const,
        body: {
          error: {
            type: "api_error" as const,
            code: "internal_error",
            message: "Failed to create run",
          },
        },
      };
    }

    // Generate sandbox token and dispatch
    const sandboxToken = await generateSandboxToken(auth.userId, run.id);

    const context = await runService.buildExecutionContext({
      checkpointId: body.checkpoint_id,
      sessionId: body.session_id,
      agentComposeVersionId: agentComposeVersionId!,
      vars: body.variables,
      secrets: body.secrets,
      volumeVersions: body.volumes,
      prompt: body.prompt,
      runId: run.id,
      sandboxToken,
      userId: auth.userId,
      agentName: agentCompose?.name,
      resumedFromCheckpointId: body.checkpoint_id,
      continuedFromSessionId: body.session_id,
    });

    const result = await runService.prepareAndDispatch(context);

    return {
      status: 202 as const,
      body: {
        id: run.id,
        agent_id: agentCompose?.id ?? "",
        agent_name: agentCompose?.name ?? "unknown",
        status: result.status as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "timeout"
          | "cancelled",
        prompt: body.prompt,
        created_at: run.createdAt.toISOString(),
        started_at: null,
        completed_at: null,
        error: null,
        execution_time_ms: null,
        checkpoint_id: null,
        session_id: body.session_id ?? null,
        artifact_name: body.artifact_name ?? null,
        artifact_version: body.artifact_version ?? null,
        volumes: body.volumes,
      },
    };
  },
});

const handler = createPublicApiHandler(publicRunsListContract, router);

export { handler as GET, handler as POST };
