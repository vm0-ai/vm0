/**
 * Public API v1 - Run by ID Endpoint
 *
 * GET /v1/runs/:id - Get run details
 */
import { initServices } from "../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../src/lib/public-api/handler";
import { publicRunByIdContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../src/lib/public-api/auth";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";

interface RunResult {
  checkpointId?: string;
  agentSessionId?: string;
  artifactName?: string;
  artifactVersion?: string;
  volumes?: Record<string, string>;
}

function buildRunResponseBody(
  run: typeof agentRuns.$inferSelect,
  compose: typeof agentComposes.$inferSelect | null,
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "timeout"
    | "cancelled",
  error: string | null,
) {
  const runResult = run.result as RunResult | null;
  let executionTimeMs: number | null = null;
  if (run.startedAt && run.completedAt) {
    executionTimeMs = run.completedAt.getTime() - run.startedAt.getTime();
  }
  return {
    id: run.id,
    agentId: compose?.id ?? "",
    agentName: compose?.name ?? "unknown",
    status,
    prompt: run.prompt,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    error,
    executionTimeMs,
    checkpointId: runResult?.checkpointId ?? null,
    sessionId: runResult?.agentSessionId ?? null,
    artifactName: runResult?.artifactName ?? null,
    artifactVersion: runResult?.artifactVersion ?? null,
    volumes: runResult?.volumes,
  };
}

const router = tsr.router(publicRunByIdContract, {
  get: async ({ params, headers }) => {
    initServices();

    const auth = await authenticatePublicApi(headers.authorization);
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

    // Find run by ID, ensuring it belongs to user
    const [result] = await globalThis.services.db
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
      .where(eq(agentRuns.id, params.id))
      .limit(1);

    if (!result) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such run: '${params.id}'`,
          },
        },
      };
    }

    // Verify ownership
    if (result.run.userId !== auth.userId) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such run: '${params.id}'`,
          },
        },
      };
    }

    const { run, compose } = result;

    return {
      status: 200 as const,
      body: buildRunResponseBody(
        run,
        compose,
        run.status as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "timeout"
          | "cancelled",
        run.error ?? null,
      ),
    };
  },
});

const handler = createPublicApiHandler(publicRunByIdContract, router);

export { handler as GET };
