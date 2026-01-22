/**
 * Public API v1 - Cancel Run Endpoint
 *
 * POST /v1/runs/:id/cancel - Cancel a pending or running execution
 */
import { initServices } from "../../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../../src/lib/public-api/handler";
import { publicRunCancelContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../../src/lib/public-api/auth";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";

interface RunResult {
  output?: string;
  checkpointId?: string;
  agentSessionId?: string;
  artifactName?: string;
  artifactVersion?: string;
  volumes?: Record<string, string>;
}

const CANCELLABLE_STATUSES = ["pending", "running"];

const router = tsr.router(publicRunCancelContract, {
  // eslint-disable-next-line complexity -- TODO: refactor complex function
  cancel: async ({ params }) => {
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

    // Find run by ID
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

    // Check if run is in a cancellable state
    if (!CANCELLABLE_STATUSES.includes(run.status)) {
      return {
        status: 400 as const,
        body: {
          error: {
            type: "invalid_request_error" as const,
            code: "invalid_state",
            message: `Run cannot be cancelled: current status is '${run.status}'`,
          },
        },
      };
    }

    // Update run status to cancelled
    const now = new Date();
    const [updatedRun] = await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "cancelled",
        completedAt: now,
      })
      .where(eq(agentRuns.id, params.id))
      .returning();

    if (!updatedRun) {
      return {
        status: 500 as const,
        body: {
          error: {
            type: "api_error" as const,
            code: "internal_error",
            message: "Failed to cancel run",
          },
        },
      };
    }

    // Parse result JSON for output and other fields
    const runResult = updatedRun.result as RunResult | null;

    // Calculate execution time if started
    let executionTimeMs: number | null = null;
    if (updatedRun.startedAt && updatedRun.completedAt) {
      executionTimeMs =
        updatedRun.completedAt.getTime() - updatedRun.startedAt.getTime();
    }

    return {
      status: 200 as const,
      body: {
        id: updatedRun.id,
        agent_id: compose?.id ?? "",
        agent_name: compose?.name ?? "unknown",
        status: "cancelled" as const,
        prompt: updatedRun.prompt,
        created_at: updatedRun.createdAt.toISOString(),
        started_at: updatedRun.startedAt?.toISOString() ?? null,
        completed_at: updatedRun.completedAt?.toISOString() ?? null,
        output: runResult?.output ?? null,
        error: null,
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

const handler = createPublicApiHandler(publicRunCancelContract, router);

export { handler as POST };
