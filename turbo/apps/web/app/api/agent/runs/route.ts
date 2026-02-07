import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { runsMainContract, type RunStatus } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { and, eq, inArray, desc } from "drizzle-orm";
import {
  checkRunConcurrencyLimit,
  validateCheckpoint,
  validateAgentSession,
  buildExecutionContext,
  prepareAndDispatchRun,
} from "../../../../src/lib/run";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { generateSandboxToken } from "../../../../src/lib/auth/sandbox-token";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";
import { extractTemplateVars } from "../../../../src/lib/config-validator";
import { assertImageAccess } from "../../../../src/lib/image/image-service";
import { logger } from "../../../../src/lib/logger";
import { isConcurrentRunLimit } from "../../../../src/lib/errors";
import { getVariableValues } from "../../../../src/lib/variable/variable-service";
import { getUserScopeByClerkId } from "../../../../src/lib/scope/scope-service";
import { getUserEmail } from "../../../../src/lib/auth/get-user-email";
import { canAccessCompose } from "../../../../src/lib/agent/permission-service";

const log = logger("api:runs");

const router = tsr.router(runsMainContract, {
  list: async ({ query, headers }) => {
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

    // Build query conditions
    const conditions = [eq(agentRuns.userId, userId)];

    // Filter by status if provided, otherwise return pending and running
    if (query.status) {
      conditions.push(eq(agentRuns.status, query.status));
    } else {
      conditions.push(inArray(agentRuns.status, ["pending", "running"]));
    }

    // Query runs with compose name via JOIN (single query instead of 3)
    const runs = await globalThis.services.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        prompt: agentRuns.prompt,
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
          createdAt: run.createdAt.toISOString(),
          startedAt: run.startedAt?.toISOString() ?? null,
        })),
      },
    };
  },
  // eslint-disable-next-line complexity -- TODO: refactor complex function
  create: async ({ body, headers }) => {
    const apiStartTime = Date.now();
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

    // Check concurrent run limit
    try {
      await checkRunConcurrencyLimit(userId);
    } catch (error) {
      if (isConcurrentRunLimit(error)) {
        return {
          status: 429 as const,
          body: {
            error: {
              message: error.message,
              code: "concurrent_run_limit_exceeded",
            },
          },
        };
      }
      throw error;
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

    // Resolve compose version ID and content for the run
    let agentComposeVersionId: string;
    let agentComposeName: string | undefined;
    let composeContent: AgentComposeYaml | undefined;
    let varsFromSource: Record<string, string> | null = null;
    let secretNamesFromSource: string[] | null = null;

    if (isNewRun) {
      if (body.agentComposeVersionId) {
        // Explicit version ID provided - use directly
        agentComposeVersionId = body.agentComposeVersionId;

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

        const [compose] = await globalThis.services.db
          .select()
          .from(agentComposes)
          .where(eq(agentComposes.id, version.composeId))
          .limit(1);

        // Check permission to access this compose
        if (compose) {
          const userEmail = await getUserEmail(userId);
          const hasAccess = await canAccessCompose(
            userId,
            userEmail,
            compose.id,
          );
          if (!hasAccess) {
            return {
              status: 403 as const,
              body: {
                error: {
                  message: "Access denied to agent",
                  code: "FORBIDDEN",
                },
              },
            };
          }
        }

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

        // Check permission to access this compose
        const userEmail = await getUserEmail(userId);
        const hasAccess = await canAccessCompose(userId, userEmail, compose.id);
        if (!hasAccess) {
          return {
            status: 403 as const,
            body: {
              error: {
                message: "Access denied to agent",
                code: "FORBIDDEN",
              },
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
      // Merge CLI-provided vars with server-stored vars for validation
      if (composeContent) {
        const requiredVars = extractTemplateVars(composeContent);
        const cliVars = body.vars || {};

        // Fetch server-stored variables to include in validation
        let storedVars: Record<string, string> = {};
        const userScope = await getUserScopeByClerkId(userId);
        if (userScope) {
          storedVars = await getVariableValues(userScope.id);
        }

        // Merge: CLI vars override server-stored vars (same priority as buildExecutionContext)
        const allVars = { ...storedVars, ...cliVars };
        const missingVars = requiredVars.filter(
          (varName) => allVars[varName] === undefined,
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
      let checkpointVars: Record<string, string> | null = null;
      let checkpointSecretNames: string[] | null = null;
      try {
        const checkpointData = await validateCheckpoint(
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

      if (!body.vars && checkpointVars) {
        varsFromSource = checkpointVars;
      }
      if (!body.secrets && checkpointSecretNames) {
        secretNamesFromSource = checkpointSecretNames;
      }

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
      // Session continue
      let sessionData;
      try {
        sessionData = await validateAgentSession(body.sessionId!, userId);
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

      // Always use HEAD compose version for session continue
      agentComposeVersionId = compose.headVersionId;
      agentComposeName = compose.name || undefined;
    }

    log.debug(`Resolved agentComposeVersionId: ${agentComposeVersionId}`);

    const varsToStore = body.vars || varsFromSource || null;
    const secretNamesToStore = body.secrets
      ? Object.keys(body.secrets)
      : secretNamesFromSource;

    // Create run record in database
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
        lastHeartbeatAt: new Date(),
      })
      .returning();

    if (!run) {
      throw new Error("Failed to create run record");
    }

    log.debug(`Created run record: ${run.id}`);

    // Generate temporary bearer token
    const sandboxToken = await generateSandboxToken(userId, run.id);

    // Build execution context and dispatch to appropriate executor
    try {
      const context = await buildExecutionContext({
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
        agentName: agentComposeName,
        resumedFromCheckpointId: body.checkpointId,
        continuedFromSessionId: body.sessionId,
        debugNoMockClaude: body.debugNoMockClaude,
        modelProvider: body.modelProvider,
        apiStartTime,
      });

      // Prepare and dispatch to executor (unified path for E2B and runner)
      const result = await prepareAndDispatchRun(context);

      log.debug(
        `Run ${run.id} dispatched successfully (status: ${result.status})`,
      );

      return {
        status: 201 as const,
        body: {
          runId: run.id,
          status: result.status,
          sandboxId: result.sandboxId,
          createdAt: run.createdAt.toISOString(),
        },
      };
    } catch (error) {
      let errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      const errorWithResult = error as { result?: { stderr?: string } };
      if (errorWithResult.result?.stderr) {
        errorMessage = errorWithResult.result.stderr;
      }

      log.error(`Run ${run.id} preparation failed: ${errorMessage}`);
      await globalThis.services.db
        .update(agentRuns)
        .set({
          status: "failed",
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));

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
