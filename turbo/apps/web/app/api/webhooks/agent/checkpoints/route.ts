import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentCheckpoints } from "../../../../../src/db/schema/agent-checkpoint";
import { eq } from "drizzle-orm";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";
import type { VolumeSnapshot } from "../../../../../src/db/schema/agent-checkpoint";

/**
 * POST /api/webhooks/agent/checkpoints
 * Create a checkpoint from agent run (called from sandbox)
 *
 * This is a webhook endpoint called by run-agent.sh in the sandbox
 * after Claude Code execution completes successfully.
 */
export async function POST(request: NextRequest) {
  try {
    initServices();

    // Verify webhook authentication using Bearer token
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing or invalid authorization header");
    }

    // Get request body
    const body = await request.json();
    const {
      runId,
      sessionId,
      sessionContent,
      workingDirectory,
      encodedPath,
      volumeSnapshots,
    } = body;

    if (
      !runId ||
      !sessionId ||
      !sessionContent ||
      !workingDirectory ||
      !encodedPath
    ) {
      throw new BadRequestError(
        "Missing required fields: runId, sessionId, sessionContent, workingDirectory, encodedPath",
      );
    }

    // Verify run exists
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    console.log(
      `[Checkpoint Webhook] Creating checkpoint for run ${runId}, session ${sessionId}`,
    );
    console.log(
      `[Checkpoint Webhook] Session content size: ${sessionContent.length} bytes`,
    );

    // Parse volume snapshots if provided
    const parsedVolumeSnapshots: VolumeSnapshot[] = volumeSnapshots || [];

    // Create checkpoint record with session content stored in DB
    const [checkpoint] = await globalThis.services.db
      .insert(agentCheckpoints)
      .values({
        runId,
        sessionId,
        sessionContent,
        volumeSnapshots: parsedVolumeSnapshots,
        workingDirectory,
        encodedPath,
      })
      .returning();

    console.log(
      `[Checkpoint Webhook] Created checkpoint ${checkpoint!.id} for run ${runId}`,
    );

    return successResponse(
      {
        checkpointId: checkpoint!.id,
        sessionId,
        volumeSnapshots: parsedVolumeSnapshots,
        sessionSize: sessionContent.length,
      },
      201,
    );
  } catch (error) {
    console.error("[Checkpoint Webhook] Error:", error);
    return errorResponse(error);
  }
}
