import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";
import { checkpointService } from "../../../../../src/lib/checkpoint";
import type {
  CheckpointRequest,
  CheckpointResponse,
} from "../../../../../src/lib/checkpoint";
import {
  sendVm0ResultEvent,
  sendVm0ErrorEvent,
} from "../../../../../src/lib/events";

/**
 * POST /api/webhooks/agent/checkpoints
 * Create checkpoint for completed agent run
 */
export async function POST(request: NextRequest) {
  // Track runId at top level for error handling
  let runId: string | undefined;

  try {
    // Initialize services
    initServices();

    // Authenticate using bearer token
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Parse request body
    const body: CheckpointRequest = await request.json();

    // Store runId for error handling
    runId = body.runId;

    // Validate required fields
    if (!body.runId) {
      throw new BadRequestError("Missing runId");
    }

    if (!body.sessionId) {
      throw new BadRequestError("Missing sessionId");
    }

    if (!body.sessionHistory) {
      throw new BadRequestError("Missing sessionHistory");
    }

    if (!body.volumeSnapshots || !Array.isArray(body.volumeSnapshots)) {
      throw new BadRequestError("Missing or invalid volumeSnapshots array");
    }

    console.log(
      `[Checkpoint API] Received checkpoint request for run ${body.runId} from user ${userId}`,
    );

    // Verify run exists and belongs to the authenticated user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    // Note: We don't check run status here because the checkpoint is called from within
    // the sandbox before the E2B service updates the run status to "completed"

    // Create checkpoint
    const result = await checkpointService.createCheckpoint(body);

    console.log(
      `[Checkpoint API] Checkpoint created: ${result.checkpointId} with ${result.volumeSnapshots} snapshot(s)`,
    );

    // Send vm0_result event
    await sendVm0ResultEvent({
      runId: body.runId,
      checkpointId: result.checkpointId,
      volumeSnapshots: result.volumeSnapshots,
    });

    // Return response
    const response: CheckpointResponse = {
      checkpointId: result.checkpointId,
      volumeSnapshots: result.volumeSnapshots,
    };

    return successResponse(response, 200);
  } catch (error) {
    console.error("[Checkpoint API] Error:", error);

    // Try to send vm0_error event so CLI doesn't timeout
    if (runId) {
      try {
        await sendVm0ErrorEvent({
          runId,
          error: error instanceof Error ? error.message : "Checkpoint failed",
        });
      } catch {
        // Ignore errors when sending error event
        console.error(
          "[Checkpoint API] Failed to send vm0_error event after checkpoint failure",
        );
      }
    }

    return errorResponse(error);
  }
}
