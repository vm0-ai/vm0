import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";
import type { GetAgentRunResponse } from "../../../../../src/types/agent-run";

/**
 * GET /api/agent/runs/:id
 * Get agent run status and results
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Initialize services
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Await params
    const { id } = await params;

    // Query run from database
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, id))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    // Return response
    const response: GetAgentRunResponse = {
      runId: run.id,
      agentComposeVersionId: run.agentComposeVersionId,
      status: run.status as "pending" | "running" | "completed" | "failed",
      prompt: run.prompt,
      templateVars: run.templateVars as Record<string, string> | undefined,
      sandboxId: run.sandboxId || undefined,
      result: run.result as
        | { output: string; executionTimeMs: number }
        | undefined,
      error: run.error || undefined,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString(),
      completedAt: run.completedAt?.toISOString(),
    };

    return successResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
}
