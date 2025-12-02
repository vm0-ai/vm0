import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { checkpoints } from "../../../../../src/db/schema/checkpoint";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
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
import {
  sendVm0ResultEvent,
  sendVm0ErrorEvent,
} from "../../../../../src/lib/events";
import { e2bService } from "../../../../../src/lib/e2b/e2b-service";
import type { ArtifactSnapshot } from "../../../../../src/lib/checkpoint";

/**
 * Request body for complete webhook endpoint
 */
interface CompleteRequest {
  runId: string;
  exitCode: number;
  error?: string;
}

/**
 * Response from complete endpoint
 */
interface CompleteResponse {
  success: boolean;
  status: "completed" | "failed";
}

/**
 * POST /api/webhooks/agent/complete
 * Handle agent run completion (success or failure)
 * - Sends vm0_result or vm0_error event
 * - Updates run status
 * - Kills sandbox
 */
export async function POST(request: NextRequest) {
  let runId: string | undefined;
  let sandboxId: string | undefined;

  try {
    // Initialize services
    initServices();

    // Authenticate using bearer token
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Parse request body
    const body: CompleteRequest = await request.json();

    // Validate required fields
    if (!body.runId) {
      throw new BadRequestError("Missing runId");
    }

    if (typeof body.exitCode !== "number") {
      throw new BadRequestError("Missing or invalid exitCode");
    }

    runId = body.runId;

    console.log(
      `[Complete API] Received completion for run ${runId}, exitCode=${body.exitCode}`,
    );

    // Get run record
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    sandboxId = run.sandboxId ?? undefined;

    // Idempotency check: if run is already completed/failed, return early
    if (run.status === "completed" || run.status === "failed") {
      console.log(
        `[Complete API] Run ${runId} already ${run.status}, skipping duplicate completion`,
      );
      return successResponse(
        { success: true, status: run.status as "completed" | "failed" },
        200,
      );
    }

    let finalStatus: "completed" | "failed";

    if (body.exitCode === 0) {
      // Success: query checkpoint and send vm0_result
      const [checkpoint] = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.runId, runId))
        .limit(1);

      if (!checkpoint) {
        throw new NotFoundError("Checkpoint for run");
      }

      // Get agent session for the conversation
      const [session] = await globalThis.services.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.conversationId, checkpoint.conversationId))
        .limit(1);

      // Extract artifact info from checkpoint
      const artifactSnapshot = checkpoint.artifactSnapshot as ArtifactSnapshot;
      const volumeVersions = checkpoint.volumeVersionsSnapshot as
        | { versions: Record<string, string> }
        | undefined;

      // Send vm0_result event
      await sendVm0ResultEvent({
        runId,
        checkpointId: checkpoint.id,
        agentSessionId: session?.id ?? checkpoint.conversationId,
        conversationId: checkpoint.conversationId,
        artifact: {
          [artifactSnapshot.artifactName]: artifactSnapshot.artifactVersion,
        },
        volumes: volumeVersions?.versions,
      });

      // Update run status to completed
      await globalThis.services.db
        .update(agentRuns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(agentRuns.id, runId));

      finalStatus = "completed";
      console.log(`[Complete API] Run ${runId} completed successfully`);
    } else {
      // Failure: send vm0_error event
      const errorMessage =
        body.error || `Agent exited with code ${body.exitCode}`;

      await sendVm0ErrorEvent({
        runId,
        error: errorMessage,
        sandboxId,
      });

      // Update run status to failed
      await globalThis.services.db
        .update(agentRuns)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(agentRuns.id, runId));

      finalStatus = "failed";
      console.log(`[Complete API] Run ${runId} failed: ${errorMessage}`);
    }

    // Kill sandbox (fire-and-forget, don't block response)
    if (sandboxId) {
      e2bService.killSandbox(sandboxId).catch((error) => {
        console.error(
          `[Complete API] Failed to kill sandbox ${sandboxId}:`,
          error,
        );
      });
    }

    const response: CompleteResponse = {
      success: true,
      status: finalStatus,
    };

    return successResponse(response, 200);
  } catch (error) {
    console.error("[Complete API] Error:", error);

    // Try to send vm0_error event if we have runId
    if (runId) {
      try {
        await sendVm0ErrorEvent({
          runId,
          error: error instanceof Error ? error.message : "Complete API failed",
          sandboxId,
        });
      } catch {
        console.error(
          "[Complete API] Failed to send vm0_error event after error",
        );
      }
    }

    // Still try to kill sandbox on error
    if (sandboxId) {
      e2bService.killSandbox(sandboxId).catch(() => {
        // Ignore cleanup errors
      });
    }

    return errorResponse(error);
  }
}
