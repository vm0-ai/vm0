import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { runsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { runService } from "../../../../src/lib/run";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { generateSandboxToken } from "../../../../src/lib/auth/sandbox-token";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";
import { extractTemplateVars } from "../../../../src/lib/config-validator";
import { assertImageAccess } from "../../../../src/lib/image/image-service";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:runs");

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

    // For new runs, require either agentComposeId or agentComposeVersionId, and artifactName
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
      if (!body.artifactName) {
        return {
          status: 400 as const,
          body: {
            error: {
              message:
                "Missing artifactName. Use --artifact-name flag to specify artifact.",
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
        const providedVars = body.templateVars || {};
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
      // Validate checkpoint first to get agentComposeVersionId
      try {
        const sessionData = await runService.validateCheckpoint(
          body.checkpointId!,
          userId,
        );
        agentComposeVersionId = sessionData.agentComposeVersionId;
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
      // Session continue - resolve to HEAD version of session's compose
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

      // Get compose and resolve to HEAD version
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

      agentComposeVersionId = compose.headVersionId;
      agentComposeName = compose.name || undefined;
    }

    log.debug(`Resolved agentComposeVersionId: ${agentComposeVersionId}`);

    // Create run record in database
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        agentComposeVersionId,
        status: "pending",
        prompt: body.prompt,
        templateVars: body.templateVars || null,
        resumedFromCheckpointId: body.checkpointId || null,
      })
      .returning();

    if (!run) {
      throw new Error("Failed to create run record");
    }

    log.debug(`Created run record: ${run.id}`);

    // Generate temporary bearer token for E2B sandbox
    const sandboxToken = await generateSandboxToken(userId, run.id);
    log.debug(`Generated sandbox token for run: ${run.id}`);

    // Update run status to 'running' before starting E2B execution
    // Initialize lastHeartbeatAt for sandbox cleanup monitoring
    await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "running",
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id));

    // Build execution context and start sandbox (fire-and-forget)
    // vm0_start event is sent by E2B service after storage preparation
    // Final status will be updated by webhook when run-agent.sh completes
    try {
      const context = await runService.buildExecutionContext({
        checkpointId: body.checkpointId,
        sessionId: body.sessionId,
        agentComposeVersionId:
          body.agentComposeVersionId || agentComposeVersionId,
        conversationId: body.conversationId,
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        templateVars: body.templateVars,
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

      // Start execution - returns immediately after sandbox is prepared
      // Agent execution continues in background (fire-and-forget)
      // Note: sandboxId is persisted to database inside executeRun() immediately after sandbox creation
      const result = await runService.executeRun(context);

      log.debug(
        `Run ${run.id} started successfully (sandbox: ${result.sandboxId})`,
      );
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

    // Return response with 'running' status
    // Final status will be updated by webhook when agent completes
    return {
      status: 201 as const,
      body: {
        runId: run.id,
        status: "running" as const,
        createdAt: run.createdAt.toISOString(),
      },
    };
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

const handler = createNextHandler(runsMainContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as POST };
