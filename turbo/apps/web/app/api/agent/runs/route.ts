import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import {
  runsMainContract,
  ALL_RUN_STATUSES,
  type RunStatus,
} from "@vm0/api-contracts/contracts/runs";
import { orgTierSchema } from "@vm0/api-contracts/contracts/orgs";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import type { AdditionalVolume } from "../../../../src/lib/infra/storage/types";
import { and, eq, inArray, desc, gte, lte, sql } from "drizzle-orm";
import {
  loadCompose,
  insertRunRecord,
  buildAndDispatchRun,
  markRunFailed,
  type RunDispatchError,
} from "../../../../src/lib/infra/run";
import type { ContextArtifact } from "../../../../src/lib/infra/run/types";
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
} from "@vm0/api-services/errors";
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
 * Merge body/resolved additionalVolumes, normalizing empty arrays to undefined.
 *
 * Body volumes take precedence over resolved context. The CLI run path is
 * skill-agnostic: zeroAgents.customSkills are not injected here (they belong
 * exclusively to /api/zero/runs).
 */
function resolveRunAdditionalVolumes(params: {
  bodyAdditionalVolumes: AdditionalVolume[] | undefined;
  resolvedAdditionalVolumes: AdditionalVolume[] | undefined;
}): AdditionalVolume[] | undefined {
  const merged =
    params.bodyAdditionalVolumes ?? params.resolvedAdditionalVolumes;
  return merged && merged.length > 0 ? merged : undefined;
}

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
    // Post-INSERT errors have runId + sessionId attached by markRunFailed().
    // Return 201 with failed status so the client can track the run.
    const dispatchError = error as RunDispatchError;
    if (dispatchError.runId && dispatchError.sessionId) {
      return {
        status: 201 as const,
        body: {
          runId: dispatchError.runId,
          status: "failed" as const,
          sessionId: dispatchError.sessionId,
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
  if (dispatchError.runId && dispatchError.sessionId) {
    return {
      status: 201 as const,
      body: {
        runId: dispatchError.runId,
        status: "failed" as const,
        sessionId: dispatchError.sessionId,
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
    const apiStartTime = Date.now();
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
      const { composeContent, compose } = await loadCompose(
        composeMeta.agentComposeVersionId,
        composeMeta.composeId,
      );
      authorizeCompose(userId, org.orgId, compose);
      const authorizeTime = Date.now();

      // 4. Validate compose requirements (new runs only).
      // CLI requests carry no modelProvider/modelProviderId, so pass null —
      // the validator's existing behavior (compose env required for non-
      // claude-code frameworks) is preserved on this path.
      if (!body.checkpointId && !body.sessionId) {
        await validateComposeRequirements(composeContent, null);
      }

      // 5. Validate mutual exclusivity
      if (body.checkpointId && body.sessionId) {
        throw badRequest(
          "Cannot specify both checkpointId and sessionId. Use checkpointId to resume from a checkpoint, or sessionId to continue a session.",
        );
      }

      // 6. Resolve additional volumes (body takes precedence over resolved context)
      const finalAdditionalVolumes = resolveRunAdditionalVolumes({
        bodyAdditionalVolumes: body.additionalVolumes,
        resolvedAdditionalVolumes: resolved.additionalVolumes,
      });

      // 7. Merge artifacts: resolved (checkpoint/session snapshot) first,
      //    body.artifacts (CLI --artifact flag) second so per-run overrides
      //    win dedup-by-name in prepareStorageManifest.
      const mergedArtifacts: ContextArtifact[] = [
        ...resolved.artifacts,
        ...(body.artifacts ?? []),
      ];

      // 8. Concurrency check + INSERT (transaction with advisory lock)
      const run = await globalThis.services.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${org.orgId}))`,
        );
        await checkRunConcurrencyLimit(org.orgId, orgTier, tx);
        return insertRunRecord(tx, {
          userId,
          orgId: org.orgId,
          agentComposeId: compose.id,
          agentComposeVersionId: composeMeta.agentComposeVersionId,
          prompt: body.prompt,
          appendSystemPrompt: body.appendSystemPrompt,
          vars: resolved.vars ?? body.vars,
          secrets: resolved.secrets ?? body.secrets,
          additionalVolumes: finalAdditionalVolumes,
          resumedFromCheckpointId: body.checkpointId,
          sessionId: body.sessionId,
          // Seed agent_sessions.artifacts from the merged list so future
          // continues can resolve the mount set. resolved.artifacts already
          // carries any memory entry from the session/checkpoint snapshot;
          // body.artifacts (CLI --artifact) is trusted as declared.
          // For resumes, this is unused since the existing session row is reused.
          artifacts: mergedArtifacts,
        });
      });
      const transactionTime = Date.now();

      // 8. Generate sandbox token
      const sandboxToken = await generateSandboxToken(
        userId,
        run.id,
        org.orgId,
      );
      const tokenTime = Date.now();

      try {
        // 9. Build execution context (pure infra — all business data pre-resolved)
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
          secretConnectorMetadataMap: resolved.secretConnectorMetadataMap,
          artifacts: mergedArtifacts,
          volumeVersions: resolved.volumeVersions ?? body.volumeVersions,
          additionalVolumes: finalAdditionalVolumes,
          environment: resolved.environment,
          userTimezone: resolved.userTimezone,
          firewalls: resolved.firewalls,
          networkPolicies: resolved.networkPolicies,
          disallowedTools: body.disallowedTools,
          tools: body.tools,
          settings: body.settings,
          resumeSession: resolved.resumeSession,
          agentName: composeMeta.agentName,
          resumedFromCheckpointId: body.checkpointId,
          continuedFromSessionId: body.sessionId,
          debugNoMockClaude: body.debugNoMockClaude,
          debugNoMockCodex: body.debugNoMockCodex,
          captureNetworkBodies: body.captureNetworkBodies,
          billableFirewalls: resolved.billableFirewalls,
          modelUsageProvider: resolved.modelUsageProvider,
          apiStartTime,
        });

        // 10. Dispatch
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
            sessionId: run.sessionId,
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
  routeName: "agent.runs",
  errorHandler,
});

export { handler as GET, handler as POST };
