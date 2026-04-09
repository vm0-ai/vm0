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
import { and, eq, inArray, desc, gte, lte, sql } from "drizzle-orm";
import {
  loadCompose,
  insertRunRecord,
  buildAndDispatchRun,
  markRunFailed,
  type RunDispatchError,
} from "../../../../src/lib/infra/run";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { logger } from "../../../../src/lib/shared/logger";
import {
  isApiError,
  notFound,
  badRequest,
  forbidden,
} from "../../../../src/lib/shared/errors";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { resolveCliRunContext } from "../../../../src/lib/zero/build-zero-context";
import { resolveStartRunCompose } from "../../../../src/lib/zero/zero-run-validation";
import {
  authorizeCompose,
  validateComposeRequirements,
  checkRunConcurrencyLimit,
} from "../../../../src/lib/zero/zero-run-policy";
import { generateSandboxToken } from "../../../../src/lib/auth/sandbox-token";
import { buildInfraExecutionContext } from "../../../../src/lib/infra/run/context/build-context";
import { getCachedUser } from "../../../../src/lib/auth/user-cache-service";
import { env } from "../../../../src/env";

const log = logger("api:runs");

/**
 * Gate captureNetworkBodies to @vm0.ai accounts in production.
 * Throws ForbiddenError for non-internal accounts.
 */
async function enforceCaptureNetworkBodiesGate(
  userId: string,
  captureNetworkBodies: boolean | undefined,
): Promise<void> {
  if (!captureNetworkBodies || env().VERCEL_ENV !== "production") return;
  const { email } = await getCachedUser(userId);
  if (!email.endsWith("@vm0.ai")) {
    throw forbidden("captureNetworkBodies is restricted to internal accounts");
  }
}

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
    // before building the execution context.
    try {
      await enforceCaptureNetworkBodiesGate(userId, body.captureNetworkBodies);

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
        permissionPolicies: body.permissionPolicies,
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        memoryName: body.memoryName,
        volumeVersions: body.volumeVersions,
      });

      const orgTier = orgTierSchema.parse(org.tier);

      // 1. Resolve compose version
      const composeMeta = await resolveStartRunCompose({
        userId,
        composeId: body.agentComposeId,
        agentComposeVersionId:
          resolved.agentComposeVersionId ?? body.agentComposeVersionId,
        checkpointId: body.checkpointId,
        sessionId: body.sessionId,
      });

      // 2. Cross-org check: ensure compose belongs to caller's org
      if (composeMeta.orgId !== org.orgId) {
        throw notFound("Resource not found");
      }

      // 3. Load compose and authorize
      const apiStartTime = Date.now();
      const { composeContent, compose } = await loadCompose(
        composeMeta.agentComposeVersionId,
        composeMeta.composeId,
      );
      authorizeCompose(userId, org.orgId, compose);
      const authorizeTime = Date.now();

      // 4. Validate compose requirements (new runs only)
      if (!body.checkpointId && !body.sessionId) {
        await validateComposeRequirements(composeContent);
      }

      // 5. Validate mutual exclusivity
      if (body.checkpointId && body.sessionId) {
        throw badRequest(
          "Cannot specify both checkpointId and sessionId. Use checkpointId to resume from a checkpoint, or sessionId to continue a session.",
        );
      }

      // 6. Concurrency check + INSERT (transaction with advisory lock)
      const run = await globalThis.services.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${org.orgId}))`,
        );
        await checkRunConcurrencyLimit(org.orgId, orgTier, tx);
        return insertRunRecord(tx, {
          userId,
          orgId: org.orgId,
          agentComposeVersionId: composeMeta.agentComposeVersionId,
          prompt: body.prompt,
          appendSystemPrompt: body.appendSystemPrompt,
          vars: resolved.vars ?? body.vars,
          secrets: resolved.secrets ?? body.secrets,
          resumedFromCheckpointId: body.checkpointId,
          sessionId: body.sessionId,
        });
      });
      const transactionTime = Date.now();

      // 7. Generate sandbox token
      const sandboxToken = await generateSandboxToken(userId, run.id);
      const tokenTime = Date.now();

      try {
        // 8. Build execution context (pure infra — all business data pre-resolved)
        const { context } = buildInfraExecutionContext({
          runId: run.id,
          userId,
          orgId: org.orgId,
          agentComposeVersionId: composeMeta.agentComposeVersionId,
          agentCompose: composeContent,
          prompt: body.prompt,
          sandboxToken,
          appendSystemPrompt: body.appendSystemPrompt,
          vars: resolved.vars ?? body.vars,
          secrets: resolved.secrets ?? body.secrets,
          secretConnectorMap: resolved.secretConnectorMap,
          artifactName: resolved.artifactName ?? body.artifactName,
          artifactVersion: resolved.artifactVersion ?? body.artifactVersion,
          memoryName: resolved.memoryName ?? body.memoryName,
          volumeVersions: resolved.volumeVersions ?? body.volumeVersions,
          environment: resolved.environment,
          userTimezone: resolved.userTimezone,
          firewalls: resolved.firewalls,
          grantedPermissions: resolved.grantedPermissions,
          disallowedTools: body.disallowedTools,
          tools: body.tools,
          settings: body.settings,
          resumeSession: resolved.resumeSession,
          resumeArtifact: resolved.resumeArtifact,
          agentName: composeMeta.agentName,
          resumedFromCheckpointId: body.checkpointId,
          continuedFromSessionId: body.sessionId,
          debugNoMockClaude: body.debugNoMockClaude,
          captureNetworkBodies: body.captureNetworkBodies,
        });

        // 9. Dispatch
        const dispatchResult = await buildAndDispatchRun({
          runId: run.id,
          context,
          timings: {
            apiStart: apiStartTime,
            authorize: authorizeTime,
            transaction: transactionTime,
            token: tokenTime,
            resolveSourceDuration: resolved.timings.resolveSource,
            resolveSecretsDuration: resolved.timings.resolveSecrets,
          },
        });

        log.debug(
          `Run ${run.id} dispatched successfully (status: ${dispatchResult.status})`,
        );

        return {
          status: 201 as const,
          body: {
            runId: run.id,
            status: dispatchResult.status as
              | "queued"
              | "pending"
              | "running"
              | "completed"
              | "failed"
              | "timeout",
            sandboxId: dispatchResult.sandboxId,
            createdAt: run.createdAt.toISOString(),
          },
        };
      } catch (error) {
        // Post-INSERT failure: mark run as failed so client can track it.
        // buildAndDispatchRun may have already called markRunFailed — the
        // second call is a safe no-op (transitionRunStatus guards on status).
        await markRunFailed(run.id, error);
        throw error;
      }
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
