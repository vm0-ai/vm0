import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { runsMainContract, type StoredExecutionContext } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { runnerJobQueue } from "../../../../src/db/schema/runner-job-queue";
import { eq } from "drizzle-orm";
import { runService } from "../../../../src/lib/run";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { generateSandboxToken } from "../../../../src/lib/auth/sandbox-token";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";
import { extractTemplateVars } from "../../../../src/lib/config-validator";
import { assertImageAccess } from "../../../../src/lib/image/image-service";
import { storageService } from "../../../../src/lib/storage/storage-service";
import { logger } from "../../../../src/lib/logger";
import { encryptSecrets } from "../../../../src/lib/crypto/secrets-encryption";
import { validateRunnerGroupScope } from "../../../../src/lib/scope/scope-service";

const log = logger("api:runs");

/**
 * Extract working directory from agent compose config
 */
function extractWorkingDir(agentCompose: unknown): string {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return "/workspace";
  const agents = Object.values(compose.agents);
  return agents[0]?.working_dir || "/workspace";
}

/**
 * Extract CLI agent type from agent compose config
 */
function extractCliAgentType(agentCompose: unknown): string {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return "claude-code";
  const agents = Object.values(compose.agents);
  return agents[0]?.provider || "claude-code";
}

/**
 * Resolve runner group from agent compose config
 */
function resolveRunnerGroup(agentCompose: unknown): string | null {
  const compose = agentCompose as AgentComposeYaml | undefined;
  if (!compose?.agents) return null;
  const agents = Object.values(compose.agents);
  return agents[0]?.experimental_runner?.group ?? null;
}

const router = tsr.router(runsMainContract, {
  create: async ({ body }) => {
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

    // Validate mutually exclusive shortcuts
    if (body.checkpointId && body.sessionId) {
      return {
        status: 400 as const,
        body: {
          error: {
            message:
              "Cannot specify both checkpointId and sessionId. Use one or the other.",
            code: "BAD_REQUEST",
          },
        },
      };
    }

    // Determine run mode and validate required parameters
    const isCheckpointResume = !!body.checkpointId;
    const isSessionContinue = !!body.sessionId;
    const isNewRun = !isCheckpointResume && !isSessionContinue;

    // For new runs, require either agentComposeId or agentComposeVersionId
    // Note: artifactName is optional - runs without artifact won't have persistent storage
    if (isNewRun) {
      if (!body.agentComposeId && !body.agentComposeVersionId) {
        return {
          status: 400 as const,
          body: {
            error: {
              message:
                "Missing agentComposeId or agentComposeVersionId. For new runs, one is required.",
              code: "BAD_REQUEST",
            },
          },
        };
      }
    }

    log.debug(
      `Creating run - mode: ${isCheckpointResume ? "checkpoint" : isSessionContinue ? "session" : "new"}`,
    );
    log.debug(
      `Request body.volumeVersions=${JSON.stringify(body.volumeVersions)}`,
    );

    // Resolve compose version ID and content for the run
    let agentComposeVersionId: string;
    let agentComposeName: string | undefined;
    let composeContent: AgentComposeYaml | undefined;
    // For continue/resume, vars and secretNames may come from session/checkpoint
    // Note: secrets values are NEVER stored - only names for validation
    let varsFromSource: Record<string, string> | null = null;
    let secretNamesFromSource: string[] | null = null;

    if (isNewRun) {
      if (body.agentComposeVersionId) {
        // Explicit version ID provided - use directly
        agentComposeVersionId = body.agentComposeVersionId;

        // Fetch version for validation
        const [version] = await globalThis.services.db
          .select()
          .from(agentComposeVersions)
          .where(eq(agentComposeVersions.id, agentComposeVersionId))
          .limit(1);

        if (!version) {
          return {
            status: 404 as const,
            body: {
              error: {
                message: "Agent compose version not found",
                code: "NOT_FOUND",
              },
            },
          };
        }

        composeContent = version.content as AgentComposeYaml;

        // Get compose name
        const [compose] = await globalThis.services.db
          .select()
          .from(agentComposes)
          .where(eq(agentComposes.id, version.composeId))
          .limit(1);

        agentComposeName = compose?.name || undefined;
      } else {
        // Resolve compose ID to HEAD version
        const composeId = body.agentComposeId!;

        const [compose] = await globalThis.services.db
          .select()
          .from(agentComposes)
          .where(eq(agentComposes.id, composeId))
          .limit(1);

        if (!compose) {
          return {
            status: 404 as const,
            body: {
              error: { message: "Agent compose not found", code: "NOT_FOUND" },
            },
          };
        }

        if (!compose.headVersionId) {
          return {
            status: 400 as const,
            body: {
              error: {
                message:
                  "Agent compose has no versions. Run 'vm0 build' first.",
                code: "BAD_REQUEST",
              },
            },
          };
        }

        agentComposeVersionId = compose.headVersionId;
        agentComposeName = compose.name || undefined;

        // Fetch version content
        const [version] = await globalThis.services.db
          .select()
          .from(agentComposeVersions)
          .where(eq(agentComposeVersions.id, agentComposeVersionId))
          .limit(1);

        if (!version) {
          return {
            status: 404 as const,
            body: {
              error: {
                message: "Agent compose version not found",
                code: "NOT_FOUND",
              },
            },
          };
        }

        composeContent = version.content as AgentComposeYaml;
      }

      // Validate template variables for new runs
      if (composeContent) {
        const requiredVars = extractTemplateVars(composeContent);
        const providedVars = body.vars || {};
        const missingVars = requiredVars.filter(
          (varName) => providedVars[varName] === undefined,
        );

        if (missingVars.length > 0) {
          return {
            status: 400 as const,
            body: {
              error: {
                message: `Missing required template variables: ${missingVars.join(", ")}`,
                code: "BAD_REQUEST",
              },
            },
          };
        }

        // Validate image access for new runs
        const agentKeys = Object.keys(composeContent.agents);
        const firstAgentKey = agentKeys[0];
        if (firstAgentKey) {
          const agent = composeContent.agents[firstAgentKey];
          if (agent?.image) {
            try {
              await assertImageAccess(userId, agent.image);
            } catch (error) {
              return {
                status: 400 as const,
                body: {
                  error: {
                    message:
                      error instanceof Error
                        ? error.message
                        : "Image access denied",
                    code: "BAD_REQUEST",
                  },
                },
              };
            }
          }
        }
      }
    } else if (isCheckpointResume) {
      // Validate checkpoint first to get agentComposeVersionId, vars, and secretNames
      // Note: secrets values are NEVER stored - only names for validation
      let checkpointVars: Record<string, string> | null = null;
      let checkpointSecretNames: string[] | null = null;
      try {
        const checkpointData = await runService.validateCheckpoint(
          body.checkpointId!,
          userId,
        );
        agentComposeVersionId = checkpointData.agentComposeVersionId;
        checkpointVars = checkpointData.vars;
        checkpointSecretNames = checkpointData.secretNames;
      } catch (error) {
        return {
          status: 404 as const,
          body: {
            error: {
              message:
                error instanceof Error ? error.message : "Checkpoint not found",
              code: "NOT_FOUND",
            },
          },
        };
      }

      // Inherit vars and secretNames from checkpoint if not provided in request
      // Note: secrets must be provided fresh each time - only names are inherited
      if (!body.vars && checkpointVars) {
        varsFromSource = checkpointVars;
      }
      if (!body.secrets && checkpointSecretNames) {
        // Only inherit secret names for validation - values must be provided
        secretNamesFromSource = checkpointSecretNames;
      }

      // Get compose name for metadata
      const [version] = await globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, agentComposeVersionId))
        .limit(1);

      if (version) {
        const [compose] = await globalThis.services.db
          .select()
          .from(agentComposes)
          .where(eq(agentComposes.id, version.composeId))
          .limit(1);
        agentComposeName = compose?.name || undefined;
      }
    } else {
      // Session continue - use session's compose version if available, otherwise HEAD
      let sessionData;
      try {
        sessionData = await runService.validateAgentSession(
          body.sessionId!,
          userId,
        );
      } catch (error) {
        return {
          status: 404 as const,
          body: {
            error: {
              message:
                error instanceof Error ? error.message : "Session not found",
              code: "NOT_FOUND",
            },
          },
        };
      }

      // Get compose to resolve version
      const [compose] = await globalThis.services.db
        .select()
        .from(agentComposes)
        .where(eq(agentComposes.id, sessionData.agentComposeId))
        .limit(1);

      if (!compose) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: "Agent compose for session not found",
              code: "NOT_FOUND",
            },
          },
        };
      }

      if (!compose.headVersionId) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: "Agent compose has no versions. Run 'vm0 build' first.",
              code: "BAD_REQUEST",
            },
          },
        };
      }

      // Use session's fixed compose version if available, fall back to HEAD for backwards compatibility
      agentComposeVersionId =
        sessionData.agentComposeVersionId || compose.headVersionId;
      agentComposeName = compose.name || undefined;

      // Inherit vars and secretNames from session if not provided in request
      // Note: secrets must be provided fresh each time - only names are inherited
      if (!body.vars && sessionData.vars) {
        varsFromSource = sessionData.vars;
      }
      if (!body.secrets && sessionData.secretNames) {
        // Only inherit secret names for validation - values must be provided
        secretNamesFromSource = sessionData.secretNames;
      }
    }

    log.debug(`Resolved agentComposeVersionId: ${agentComposeVersionId}`);

    // Determine vars to store:
    // 1. If body.vars is provided, use it (new run or override)
    // 2. If varsFromSource is set, use it (continue/resume without override)
    // 3. Otherwise, no vars
    const varsToStore = body.vars || varsFromSource || null;

    // Determine secretNames to store:
    // Note: secrets values are NEVER stored - only names for validation
    // 1. If body.secrets is provided, extract names (new run or override)
    // 2. If secretNamesFromSource is set, use it (continue/resume without override)
    // 3. Otherwise, no secretNames
    const secretNamesToStore = body.secrets
      ? Object.keys(body.secrets)
      : secretNamesFromSource;

    // Create run record in database
    // Note: vars and secretNames are inherited from session/checkpoint if not provided
    // Secrets values are NEVER stored - they must be provided fresh each time
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        agentComposeVersionId,
        status: "pending",
        prompt: body.prompt,
        vars: varsToStore,
        secretNames: secretNamesToStore,
        resumedFromCheckpointId: body.checkpointId || null,
      })
      .returning();

    if (!run) {
      throw new Error("Failed to create run record");
    }

    log.debug(`Created run record: ${run.id}`);

    // Fetch compose content if not already available (needed for checkpoint/session resume)
    if (!composeContent) {
      const [version] = await globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, agentComposeVersionId))
        .limit(1);
      if (version) {
        composeContent = version.content as AgentComposeYaml;
      }
    }

    // Generate temporary bearer token (needed for both runner and E2B paths)
    const sandboxToken = await generateSandboxToken(userId, run.id);
    log.debug(`Generated sandbox token for run: ${run.id}`);

    // Build execution context FIRST (for both paths - late routing)
    // This ensures runner jobs get the same context preparation as E2B jobs
    try {
      const context = await runService.buildExecutionContext({
        checkpointId: body.checkpointId,
        sessionId: body.sessionId,
        agentComposeVersionId:
          body.agentComposeVersionId || agentComposeVersionId,
        conversationId: body.conversationId,
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        vars: body.vars,
        secrets: body.secrets,
        volumeVersions: body.volumeVersions,
        prompt: body.prompt,
        runId: run.id,
        sandboxToken,
        userId,
        // Metadata for vm0_start event (sent by E2B service)
        agentName: agentComposeName,
        resumedFromCheckpointId: body.checkpointId,
        continuedFromSessionId: body.sessionId,
      });

      // LATE ROUTING DECISION - after context is built
      // Check for experimental_runner routing
      const runnerGroup = resolveRunnerGroup(context.agentCompose);

      if (runnerGroup) {
        log.debug(`Run ${run.id} routed to runner group: ${runnerGroup}`);

        // Validate runner group scope matches user's scope
        await validateRunnerGroupScope(userId, runnerGroup);

        // Prepare storage manifest with presigned URLs for runner
        const workingDir = extractWorkingDir(context.agentCompose);
        const storageManifest = await storageService.prepareStorageManifest(
          context.agentCompose as AgentComposeYaml,
          context.vars || {},
          userId,
          context.artifactName,
          context.artifactVersion,
          context.volumeVersions,
          context.resumeArtifact,
          workingDir,
        );

        // Encrypt secrets before storing
        const secretValues = context.secrets
          ? Object.values(context.secrets)
          : null;
        const encryptedSecrets = encryptSecrets(
          secretValues,
          globalThis.services.env.SECRETS_ENCRYPTION_KEY,
        );

        // Build stored execution context with encrypted secrets
        const storedContext: StoredExecutionContext = {
          workingDir,
          storageManifest,
          environment: context.environment || null,
          resumeSession: context.resumeSession || null,
          encryptedSecrets, // Encrypted secrets (replaces secretValues)
          cliAgentType: extractCliAgentType(context.agentCompose),
          experimentalNetworkSecurity: context.experimentalNetworkSecurity,
        };

        // Insert into runner job queue - separate table for runner jobs
        // TTL: 24 hours for job expiration
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await globalThis.services.db.insert(runnerJobQueue).values({
          runId: run.id,
          runnerGroup,
          executionContext: storedContext,
          expiresAt,
        });

        // Return early - run will be picked up by polling runner
        return {
          status: 201 as const,
          body: {
            runId: run.id,
            status: "pending" as const,
            createdAt: run.createdAt.toISOString(),
          },
        };
      }

      // E2B path - update run status to 'running' before starting execution
      // Initialize lastHeartbeatAt for sandbox cleanup monitoring
      await globalThis.services.db
        .update(agentRuns)
        .set({
          status: "running",
          startedAt: new Date(),
          lastHeartbeatAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));

      // Start execution - returns immediately after sandbox is prepared
      // Agent execution continues in background (fire-and-forget)
      // Note: sandboxId is persisted to database inside executeRun() immediately after sandbox creation
      const result = await runService.executeRun(context);

      log.debug(
        `Run ${run.id} started successfully (sandbox: ${result.sandboxId})`,
      );

      // Return response with 'running' status
      // Final status will be updated by webhook when agent completes
      return {
        status: 201 as const,
        body: {
          runId: run.id,
          status: "running" as const,
          sandboxId: result.sandboxId,
          createdAt: run.createdAt.toISOString(),
        },
      };
    } catch (error) {
      // Extract error message - E2B CommandExitError includes result with stderr
      let errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Check if error has result property (E2B CommandExitError)
      const errorWithResult = error as { result?: { stderr?: string } };
      if (errorWithResult.result?.stderr) {
        errorMessage = errorWithResult.result.stderr;
      }

      // Update run with error on preparation failure
      log.error(`Run ${run.id} preparation failed: ${errorMessage}`);
      await globalThis.services.db
        .update(agentRuns)
        .set({
          status: "failed",
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));

      // Return error response for preparation failures
      return {
        status: 201 as const,
        body: {
          runId: run.id,
          status: "failed" as const,
          error: errorMessage,
          createdAt: run.createdAt.toISOString(),
        },
      };
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
        // Include field path in error message if available
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
        // Include field path in error message if available
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

export { handler as POST };
