import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { runsMainContract, ALL_RUN_STATUSES, type RunStatus } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { and, eq, inArray, desc, gte, lte } from "drizzle-orm";
import { startRun, type RunDispatchError } from "../../../../src/lib/run";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { logger } from "../../../../src/lib/logger";
import {
  isForbidden,
  isBadRequest,
  isNotFound,
  isUnauthorized,
  isProviderIncompatible,
} from "../../../../src/lib/errors";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";

const log = logger("api:runs");

/**
 * Translate createRun() errors into API response format
 */
function handleCreateRunError(error: unknown) {
  // Provider incompatibility must be checked before RunDispatchError:
  // the error is thrown inside buildAndDispatchRun (after run INSERT),
  // so markRunFailed attaches runId. Without this early check,
  // dispatchError.runId would match first and return a generic 201 "Run failed".
  if (isProviderIncompatible(error)) {
    return {
      status: 400 as const,
      body: {
        error: { message: error.message, code: "PROVIDER_INCOMPATIBLE" },
      },
    };
  }

  const dispatchError = error as RunDispatchError;
  if (dispatchError.runId) {
    return {
      status: 201 as const,
      body: {
        runId: dispatchError.runId,
        status: "failed" as const,
        error: "Run failed",
        createdAt: dispatchError.createdAt?.toISOString() ?? "",
      },
    };
  }

  // Map unauthorized to 404 for security (don't leak resource existence).
  // This covers checkpoint/session validation failures where the resource
  // belongs to a different user.
  if (isUnauthorized(error)) {
    return {
      status: 404 as const,
      body: { error: { message: "Resource not found", code: "NOT_FOUND" } },
    };
  }
  if (isForbidden(error)) {
    return {
      status: 403 as const,
      body: { error: { message: "Access denied", code: "FORBIDDEN" } },
    };
  }
  if (isBadRequest(error)) {
    return {
      status: 400 as const,
      body: { error: { message: error.message, code: "BAD_REQUEST" } },
    };
  }
  if (isNotFound(error)) {
    return {
      status: 404 as const,
      body: { error: { message: error.message, code: "NOT_FOUND" } },
    };
  }

  return null;
}

const router = tsr.router(runsMainContract, {
  list: async ({ query, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Parse and validate status values
    const statusValues: string[] = query.status
      ? query.status.split(",").map((s: string) => s.trim())
      : ["queued", "pending", "running"]; // default

    // Validate each status value
    for (const status of statusValues) {
      if (!ALL_RUN_STATUSES.includes(status as RunStatus)) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Invalid status: ${status}. Valid values: ${ALL_RUN_STATUSES.join(", ")}`,
              code: "BAD_REQUEST",
            },
          },
        };
      }
    }

    // Build query conditions
    const conditions = [
      eq(agentRuns.userId, userId),
      eq(agentRuns.orgId, org.orgId),
    ];

    // Filter by status
    conditions.push(inArray(agentRuns.status, statusValues));

    // Filter by agent name
    if (query.agent) {
      conditions.push(eq(agentComposes.name, query.agent));
    }

    // Filter by time range
    if (query.since) {
      const sinceDate = new Date(query.since);
      if (isNaN(sinceDate.getTime())) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "Invalid since timestamp format",
              code: "BAD_REQUEST",
            },
          },
        };
      }
      conditions.push(gte(agentRuns.createdAt, sinceDate));
    }

    if (query.until) {
      const untilDate = new Date(query.until);
      if (isNaN(untilDate.getTime())) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "Invalid until timestamp format",
              code: "BAD_REQUEST",
            },
          },
        };
      }
      conditions.push(lte(agentRuns.createdAt, untilDate));
    }

    // Query runs with compose name via JOIN (single query instead of 3)
    const runs = await globalThis.services.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
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
      .orderBy(desc(agentRuns.createdAt))
      .limit(query.limit);

    return {
      status: 200 as const,
      body: {
        runs: runs.map((run) => ({
          id: run.id,
          agentName: run.composeName || "unknown",
          status: run.status as RunStatus,
          prompt: run.prompt,
          appendSystemPrompt: run.appendSystemPrompt,
          createdAt: run.createdAt.toISOString(),
          startedAt: run.startedAt?.toISOString() ?? null,
        })),
      },
    };
  },
  create: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    // Resolve caller's org for authorization (ensures org membership)
    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    log.debug(
      `Creating run - mode: ${body.checkpointId ? "checkpoint" : body.sessionId ? "session" : "new"}`,
    );

    // Delegate all resolution, validation, and dispatch to startRun()
    try {
      const result = await startRun({
        userId,
        prompt: body.prompt,
        appendSystemPrompt: body.appendSystemPrompt,
        disallowedTools: body.disallowedTools,
        composeId: body.agentComposeId,
        agentComposeVersionId: body.agentComposeVersionId,
        checkpointId: body.checkpointId,
        sessionId: body.sessionId,
        conversationId: body.conversationId,
        vars: body.vars,
        secrets: body.secrets,
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        memoryName: body.memoryName,
        volumeVersions: body.volumeVersions,
        debugNoMockClaude: body.debugNoMockClaude,
        modelProvider: body.modelProvider,
        checkEnv: body.checkEnv,
        callerOrgId: org.orgId,
      });

      log.debug(
        `Run ${result.runId} dispatched successfully (status: ${result.status})`,
      );

      return {
        status: 201 as const,
        body: {
          runId: result.runId,
          status: result.status as
            | "queued"
            | "pending"
            | "running"
            | "completed"
            | "failed"
            | "timeout",
          sandboxId: result.sandboxId,
          createdAt: result.createdAt.toISOString(),
        },
      };
    } catch (error) {
      const errorResponse = handleCreateRunError(error);
      if (errorResponse) {
        return errorResponse;
      }
      throw error;
    }
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }

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

const handler = createHandler(runsMainContract, router, {
  errorHandler,
});

export { handler as GET, handler as POST };
