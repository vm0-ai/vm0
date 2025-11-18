import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuntimes } from "../../../../src/db/schema/agent-runtime";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../src/lib/api-response";
import { NotFoundError, UnauthorizedError } from "../../../../src/lib/errors";
import type { GetAgentRuntimeResponse } from "../../../../src/types/agent-runtime";

/**
 * GET /api/agent-runtimes/:id
 * Get agent runtime status and results
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

    // Query runtime from database
    const [runtime] = await globalThis.services.db
      .select()
      .from(agentRuntimes)
      .where(eq(agentRuntimes.id, id))
      .limit(1);

    if (!runtime) {
      throw new NotFoundError("Agent runtime");
    }

    // Return response
    const response: GetAgentRuntimeResponse = {
      runtimeId: runtime.id,
      agentConfigId: runtime.agentConfigId,
      status: runtime.status as "pending" | "running" | "completed" | "failed",
      prompt: runtime.prompt,
      dynamicVars: runtime.dynamicVars as Record<string, string> | undefined,
      sandboxId: runtime.sandboxId || undefined,
      result: runtime.result as
        | { output: string; executionTimeMs: number }
        | undefined,
      error: runtime.error || undefined,
      createdAt: runtime.createdAt.toISOString(),
      startedAt: runtime.startedAt?.toISOString(),
      completedAt: runtime.completedAt?.toISOString(),
    };

    return successResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
}
