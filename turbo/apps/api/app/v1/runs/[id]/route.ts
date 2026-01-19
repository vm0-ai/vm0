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

const router = tsr.router(publicRunByIdContract, {
  get: async ({ params }) => {
    initServices();

    const auth = await authenticatePublicApi();
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

    // Parse result JSON for output and other fields
    const runResult = run.result as RunResult | null;

    // Calculate execution time if completed
    let executionTimeMs: number | null = null;
    if (run.startedAt && run.completedAt) {
      executionTimeMs = run.completedAt.getTime() - run.startedAt.getTime();
    }

    return {
      status: 200 as const,
      body: {
        id: run.id,
        agent_id: compose?.id ?? "",
        agent_name: compose?.name ?? "unknown",
        status: run.status as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "timeout"
          | "cancelled",
        prompt: run.prompt,
        created_at: run.createdAt.toISOString(),
        started_at: run.startedAt?.toISOString() ?? null,
        completed_at: run.completedAt?.toISOString() ?? null,
        error: run.error ?? null,
        execution_time_ms: executionTimeMs,
        checkpoint_id: runResult?.checkpointId ?? null,
        session_id: runResult?.agentSessionId ?? null,
        artifact_name: runResult?.artifactName ?? null,
        artifact_version: runResult?.artifactVersion ?? null,
        volumes: runResult?.volumes,
      },
    };
  },
});

const handler = createPublicApiHandler(publicRunByIdContract, router);

export { handler as GET };
