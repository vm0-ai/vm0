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
import {
  validateCheckpoint,
  validateAgentSession,
  createRun,
  type RunDispatchError,
} from "../../../../src/lib/run";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../src/lib/logger";
import {
  isConcurrentRunLimit,
  isForbidden,
  isBadRequest,
  isNotFound,
} from "../../../../src/lib/errors";

const log = logger("api:runs");

interface ResolvedCompose {
  agentComposeVersionId: string;
  agentComposeName?: string;
  composeId?: string;
}

type ErrorResponse = {
  status: 400 | 404;
  body: { error: { message: string; code: string } };
};

/**
 * Resolve compose version ID from request body parameters.
 * Handles new runs, checkpoint resumes, and session continues.
 */
async function resolveComposeVersion(
  body: {
    agentComposeId?: string;
    agentComposeVersionId?: string;
    checkpointId?: string;
    sessionId?: string;
  },
  userId: string,
): Promise<ResolvedCompose | ErrorResponse> {
  const isCheckpointResume = !!body.checkpointId;
  const isSessionContinue = !!body.sessionId;

  if (!isCheckpointResume && !isSessionContinue) {
    return resolveNewRun(body);
  }

  if (isCheckpointResume) {
    return resolveCheckpointResume(body.checkpointId!, userId);
  }

  return resolveSessionContinue(body.sessionId!, userId);
}

async function resolveNewRun(body: {
  agentComposeId?: string;
  agentComposeVersionId?: string;
}): Promise<ResolvedCompose | ErrorResponse> {
  if (body.agentComposeVersionId) {
    const [versionRow] = await globalThis.services.db
      .select({ composeName: agentComposes.name })
      .from(agentComposeVersions)
      .leftJoin(
        agentComposes,
        eq(agentComposeVersions.composeId, agentComposes.id),
      )
      .where(eq(agentComposeVersions.id, body.agentComposeVersionId))
      .limit(1);

    return {
      agentComposeVersionId: body.agentComposeVersionId,
      agentComposeName: versionRow?.composeName || undefined,
    };
  }

  const composeId = body.agentComposeId!;
  const [compose] = await globalThis.services.db
    .select({
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
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
          message: "Agent compose has no versions. Run 'vm0 build' first.",
          code: "BAD_REQUEST",
        },
      },
    };
  }

  return {
    agentComposeVersionId: compose.headVersionId,
    agentComposeName: compose.name || undefined,
    composeId,
  };
}

async function resolveCheckpointResume(
  checkpointId: string,
  userId: string,
): Promise<ResolvedCompose | ErrorResponse> {
  let agentComposeVersionId: string;
  try {
    const checkpointData = await validateCheckpoint(checkpointId, userId);
    agentComposeVersionId = checkpointData.agentComposeVersionId;
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

  const [versionWithCompose] = await globalThis.services.db
    .select({ composeName: agentComposes.name })
    .from(agentComposeVersions)
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(eq(agentComposeVersions.id, agentComposeVersionId))
    .limit(1);

  return {
    agentComposeVersionId,
    agentComposeName: versionWithCompose?.composeName || undefined,
  };
}

async function resolveSessionContinue(
  sessionId: string,
  userId: string,
): Promise<ResolvedCompose | ErrorResponse> {
  let sessionData;
  try {
    sessionData = await validateAgentSession(sessionId, userId);
  } catch (error) {
    return {
      status: 404 as const,
      body: {
        error: {
          message: error instanceof Error ? error.message : "Session not found",
          code: "NOT_FOUND",
        },
      },
    };
  }

  const [compose] = await globalThis.services.db
    .select({
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
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

  return {
    agentComposeVersionId: compose.headVersionId,
    agentComposeName: compose.name || undefined,
    composeId: sessionData.agentComposeId,
  };
}

function isErrorResponse(
  result: ResolvedCompose | ErrorResponse,
): result is ErrorResponse {
  return "status" in result;
}

/**
 * Translate createRun() errors into API response format
 */
function handleCreateRunError(error: unknown) {
  const dispatchError = error as RunDispatchError;
  if (dispatchError.runId) {
    let errorMessage = error instanceof Error ? error.message : "Unknown error";
    const errorWithResult = error as { result?: { stderr?: string } };
    if (errorWithResult.result?.stderr) {
      errorMessage = errorWithResult.result.stderr;
    }

    return {
      status: 201 as const,
      body: {
        runId: dispatchError.runId,
        status: "failed" as const,
        error: errorMessage,
        createdAt: dispatchError.createdAt?.toISOString() ?? "",
      },
    };
  }

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
  if (isForbidden(error)) {
    return {
      status: 403 as const,
      body: { error: { message: error.message, code: "FORBIDDEN" } },
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

    // Parse and validate status values
    const statusValues: string[] = query.status
      ? query.status.split(",").map((s: string) => s.trim())
      : ["pending", "running"]; // default

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
    const conditions = [eq(agentRuns.userId, userId)];

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

    // For new runs, require either agentComposeId or agentComposeVersionId
    if (!body.checkpointId && !body.sessionId) {
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
      `Creating run - mode: ${body.checkpointId ? "checkpoint" : body.sessionId ? "session" : "new"}`,
    );

    // Resolve compose version ID for the run
    const resolved = await resolveComposeVersion(body, userId);
    if (isErrorResponse(resolved)) {
      return resolved;
    }

    log.debug(
      `Resolved agentComposeVersionId: ${resolved.agentComposeVersionId}`,
    );

    // Delegate run creation, validation, and dispatch to createRun()
    try {
      const result = await createRun({
        userId,
        agentComposeVersionId: resolved.agentComposeVersionId,
        prompt: body.prompt,
        composeId: resolved.composeId,
        checkpointId: body.checkpointId,
        sessionId: body.sessionId,
        conversationId: body.conversationId,
        vars: body.vars,
        secrets: body.secrets,
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        volumeVersions: body.volumeVersions,
        resumedFromCheckpointId: body.checkpointId,
        agentName: resolved.agentComposeName,
        debugNoMockClaude: body.debugNoMockClaude,
        modelProvider: body.modelProvider,
        checkEnv: body.checkEnv,
        apiStartTime,
      });

      log.debug(
        `Run ${result.runId} dispatched successfully (status: ${result.status})`,
      );

      return {
        status: 201 as const,
        body: {
          runId: result.runId,
          status: result.status as
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
