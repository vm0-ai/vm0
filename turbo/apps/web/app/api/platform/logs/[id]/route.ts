/**
 * Platform API - Log Detail Endpoint
 *
 * GET /api/platform/logs/:id - Get agent run log details
 */
import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { platformLogsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { eq } from "drizzle-orm";

interface RunResult {
  checkpointId?: string;
  agentSessionId?: string;
  conversationId?: string;
  artifact?: Record<string, string>; // { artifactName: version }
  volumes?: Record<string, string>;
}

interface ComposeContent {
  agent?: {
    framework?: string;
  };
  agents?: Record<
    string,
    {
      framework?: string;
    }
  >;
}

/**
 * Extract framework from compose content.
 * Returns null if no framework is found.
 */
function extractFramework(content: ComposeContent | null): string | null {
  if (!content) {
    return null;
  }

  if (content.agent?.framework) {
    return content.agent.framework;
  }

  if (content.agents) {
    const firstAgentKey = Object.keys(content.agents)[0];
    if (firstAgentKey) {
      return content.agents[firstAgentKey]?.framework ?? null;
    }
  }

  return null;
}

/**
 * Extract artifact name and version from run result.
 * The artifact map has structure { artifactName: version }
 */
function extractArtifact(runResult: RunResult | null): {
  name: string | null;
  version: string | null;
} {
  if (!runResult?.artifact) {
    return { name: null, version: null };
  }

  const name = Object.keys(runResult.artifact)[0] ?? null;
  const version = name ? (runResult.artifact[name] ?? null) : null;
  return { name, version };
}

/**
 * Create unauthorized response
 */
function unauthorizedResponse() {
  return {
    status: 401 as const,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
}

/**
 * Create not found response
 */
function notFoundResponse() {
  return {
    status: 404 as const,
    body: {
      error: { message: "Log not found", code: "NOT_FOUND" },
    },
  };
}

const router = tsr.router(platformLogsByIdContract, {
  getById: async ({ params }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return unauthorizedResponse();
    }

    // Query run with compose info
    const [result] = await globalThis.services.db
      .select({
        run: agentRuns,
        compose: agentComposes,
        composeVersion: agentComposeVersions,
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
      .where(eq(agentRuns.id, params.id))
      .limit(1);

    if (!result || result.run.userId !== userId) {
      return notFoundResponse();
    }

    const { run, compose, composeVersion } = result;

    // Extract data from result
    const runResult = run.result as RunResult | null;
    const composeContent = composeVersion?.content as ComposeContent | null;

    return {
      status: 200 as const,
      body: {
        id: run.id,
        sessionId: runResult?.agentSessionId ?? null,
        agentName: compose?.name ?? "unknown",
        framework: extractFramework(composeContent),
        status: run.status as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "timeout"
          | "cancelled",
        prompt: run.prompt,
        error: run.error ?? null,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
        artifact: extractArtifact(runResult),
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
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

const handler = createHandler(platformLogsByIdContract, router, {
  errorHandler,
});

export { handler as GET };
