import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import {
  runsMainContract,
  ALL_RUN_STATUSES,
  type RunStatus,
  orgTierSchema,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { and, eq, inArray, desc, gte, lte } from "drizzle-orm";
import { startRun, type RunDispatchError } from "../../../../src/lib/infra/run";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { logger } from "../../../../src/lib/shared/logger";
import { isApiError } from "../../../../src/lib/shared/errors";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { resolveCliRunContext } from "../../../../src/lib/zero/build-zero-context";

const log = logger("api:runs");

/**
 * Translate createRun() errors into API response format.
 *
 * Uses the generic isApiError() check so that new error types
 * (with statusCode + code) are handled automatically without
 * adding per-type branches here.
 */
function handleCreateRunError(error: unknown) {
  if (isApiError(error)) {
    // Post-INSERT errors have runId attached by markRunFailed().
    // Return 201 with failed status so the client can track the run.
    const dispatchError = error as RunDispatchError;
    if (dispatchError.runId) {
      return {
        status: 201 as const,
        body: {
          runId: dispatchError.runId,
          status: "failed" as const,
          error: error.message,
        },
      };
    }

    // Pre-INSERT errors — return proper HTTP error with structured code.
    // Map UNAUTHORIZED → NOT_FOUND for security (don't leak resource existence).
    const status = error.code === "UNAUTHORIZED" ? 404 : error.statusCode;
    const code = error.code === "UNAUTHORIZED" ? "NOT_FOUND" : error.code;
    const message =
      error.code === "UNAUTHORIZED" ? "Resource not found" : error.message;
    return {
      status: status as 400 | 401 | 402 | 403 | 404 | 422 | 429 | 503,
      body: { error: { message, code } },
    };
  }

  // Non-API errors with runId (unexpected dispatch failures)
  const dispatchError = error as RunDispatchError;
  if (dispatchError.runId) {
    return {
      status: 201 as const,
      body: {
        runId: dispatchError.runId,
        status: "failed" as const,
        error: "Run failed",
      },
    };
  }

  return null;
}

const router = tsr.router(runsMainContract, {
  list: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    // Parse and validate status values
    const statusValues: string[] = query.status
      ? query.status.split(",").map((s: string) => {
          return s.trim();
        })
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
        runs: runs.map((run) => {
          return {
            id: run.id,
            agentName: run.composeName || "unknown",
            status: run.status as RunStatus,
            prompt: run.prompt,
            appendSystemPrompt: run.appendSystemPrompt,
            createdAt: run.createdAt.toISOString(),
            startedAt: run.startedAt?.toISOString() ?? null,
          };
        }),
      },
    };
  },
  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    // Resolve caller's org for authorization (ensures org membership)
    const { org } = await resolveOrg(authCtx);

    log.debug(
      `Creating run - mode: ${body.checkpointId ? "checkpoint" : body.sessionId ? "session" : "new"}`,
    );

    // Resolve zero-layer data (vars, secrets, connectors, firewalls, timezone)
    // before calling startRun(), which uses pure infra buildInfraExecutionContext.
    try {
      const resolved = await resolveCliRunContext({
        orgId: org.orgId,
        userId,
        sessionId: body.sessionId,
        checkpointId: body.checkpointId,
        conversationId: body.conversationId,
        composeId: body.agentComposeId,
        agentComposeVersionId: body.agentComposeVersionId,
        vars: body.vars,
        secrets: body.secrets,
        firewallPolicies: body.firewallPolicies,
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        memoryName: body.memoryName,
        volumeVersions: body.volumeVersions,
      });

      const orgTier = orgTierSchema.parse(org.tier);

      const result = await startRun({
        userId,
        prompt: body.prompt,
        appendSystemPrompt: body.appendSystemPrompt,
        disallowedTools: body.disallowedTools,
        tools: body.tools,
        settings: body.settings,
        composeId: body.agentComposeId,
        agentComposeVersionId:
          resolved.agentComposeVersionId ?? body.agentComposeVersionId,
        checkpointId: body.checkpointId,
        sessionId: body.sessionId,
        conversationId: body.conversationId,
        vars: resolved.vars ?? body.vars,
        secrets: resolved.secrets ?? body.secrets,
        environment: resolved.environment,
        secretConnectorMap: resolved.secretConnectorMap,
        firewalls: resolved.firewalls,
        userTimezone: resolved.userTimezone,
        artifactName: resolved.artifactName ?? body.artifactName,
        artifactVersion: resolved.artifactVersion ?? body.artifactVersion,
        memoryName: resolved.memoryName ?? body.memoryName,
        volumeVersions: resolved.volumeVersions ?? body.volumeVersions,
        resumeSession: resolved.resumeSession,
        resumeArtifact: resolved.resumeArtifact,
        debugNoMockClaude: body.debugNoMockClaude,
        captureNetworkBodies: body.captureNetworkBodies,
        firewallPolicies: body.firewallPolicies,
        callerOrgId: org.orgId,
        orgTier,
        resolveSourceDuration: resolved.timings.resolveSource,
        resolveSecretsDuration: resolved.timings.resolveSecrets,
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
